/* BristonPlay Servidor — painel do administrador e dos revendedores (sem dependências) */
(function () {
  "use strict";
  var C = window.SRV_CONFIG;
  var S = { session: null, me: null, route: "", cache: {} };

  // ============================================================ utilidades
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function h(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function fmtDate(iso, withTime) {
    if (!iso) return "—";
    var d = new Date(iso), p = function (n) { return (n < 10 ? "0" : "") + n; };
    var s = p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
    return withTime ? s + " " + p(d.getHours()) + ":" + p(d.getMinutes()) : s;
  }
  function daysLeft(iso) { return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000); }
  var toastT;
  function toast(msg, err) {
    var t = $("#toast"); t.textContent = msg; t.className = "show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = ""; }, err ? 6000 : 3000);
  }
  function copy(text) {
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { toast("Copiado!"); })
      .catch(function () { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Copiado!"); } catch (e) { /* */ } ta.remove(); });
  }
  function statusTag(l) {
    if (l.status === "disabled") return '<span class="tag bad">Bloqueado</span>';
    if (l.status === "expired") return '<span class="tag bad">Vencido</span>';
    if (l.is_trial) return '<span class="tag warn">Teste</span>';
    var d = daysLeft(l.expires_at);
    return d <= 5 ? '<span class="tag warn">Vence em ' + d + 'd</span>' : '<span class="tag ok">Ativo</span>';
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }

  // ============================================================ sessão e API
  function saveSession(s) { S.session = s; try { localStorage.setItem("srv.session", JSON.stringify(s)); } catch (e) { /* */ } }
  function loadSession() { try { return JSON.parse(localStorage.getItem("srv.session") || "null"); } catch (e) { return null; } }
  function authFetch(grant, body) {
    return fetch(C.supabaseUrl + "/auth/v1/token?grant_type=" + grant, {
      method: "POST", headers: { apikey: C.anonKey, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error_description || j.msg || j.message || "Falha no login"); return j; }); })
      .then(function (j) { var s = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 60) * 1000 }; saveSession(s); return s; });
  }
  function token() {
    var s = S.session;
    if (!s) return Promise.reject(new Error("login"));
    if (Date.now() < s.exp) return Promise.resolve(s.access);
    return authFetch("refresh_token", { refresh_token: s.refresh }).then(function (n) { return n.access; });
  }
  function api(action, body, raw) {
    return token().then(function (tk) {
      var b = Object.assign({ action: action }, body || {});
      return fetch(C.supabaseUrl + "/functions/v1/srv-api", {
        method: "POST", headers: { apikey: C.anonKey, Authorization: "Bearer " + tk, "Content-Type": "application/json" }, body: JSON.stringify(b),
      });
    }).then(function (r) {
      if (r.status === 401) { logout(); throw new Error("Sessão expirada. Entre novamente."); }
      if (raw && r.ok) return r;
      return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || ("Erro " + r.status)); return j; });
    });
  }
  function logout() { saveSession(null); try { localStorage.removeItem("srv.session"); } catch (e) { /* */ } S.me = null; render(); }

  // ============================================================ modal
  function modal(title, bodyHtml, buttons, wide) {
    var root = $("#modal-root");
    var bg = h('<div class="modal-bg"><div class="modal' + (wide ? " w" : "") + '"><h3>' + esc(title) + '</h3><div class="mb"></div><div class="foot"></div></div></div>');
    $(".mb", bg).innerHTML = bodyHtml;
    var foot = $(".foot", bg);
    var close = function () { bg.remove(); };
    (buttons || [{ label: "Fechar" }]).forEach(function (b) {
      var el = h('<button class="btn' + (b.primary ? " p" : "") + (b.danger ? " d" : "") + '">' + esc(b.label) + "</button>");
      el.addEventListener("click", function () {
        if (!b.onClick) return close();
        el.disabled = true;
        Promise.resolve(b.onClick(bg)).then(function (keep) { el.disabled = false; if (keep !== true) close(); })
          .catch(function (e) { el.disabled = false; toast(e.message || String(e), true); });
      });
      foot.appendChild(el);
    });
    bg.addEventListener("click", function (e) { if (e.target === bg) close(); });
    root.appendChild(bg);
    var f = $("input,select,textarea", bg); if (f) setTimeout(function () { f.focus(); }, 50);
    return { el: bg, close: close };
  }
  function confirmBox(title, text, okLabel, fn) {
    modal(title, '<p class="muted">' + text + "</p>", [{ label: "Cancelar" }, { label: okLabel || "Confirmar", primary: true, onClick: fn }]);
  }
  function val(el, name) { var f = $('[name="' + name + '"]', el); if (!f) return undefined; return f.type === "checkbox" ? f.checked : f.value.trim(); }

  // ============================================================ login
  function renderLogin() {
    $("#app").innerHTML =
      '<form class="login"><img src="logo.png" alt=""><h1>' + esc(C.brand) + ' Servidor</h1><p>Painel de clientes e revendas</p>' +
      '<label>E-mail</label><input name="email" type="email" autocomplete="username" required>' +
      '<label>Senha</label><input name="password" type="password" autocomplete="current-password" required>' +
      '<div style="margin-top:16px"><button class="btn p" style="width:100%">Entrar</button></div></form>';
    $(".login").addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = $("button", e.target); btn.disabled = true;
      authFetch("password", { email: val(e.target, "email"), password: $('[name="password"]', e.target).value })
        .then(loadMe).then(function () { location.hash = "#inicio"; render(); })
        .catch(function (er) { btn.disabled = false; toast(/invalid/i.test(er.message) ? "E-mail ou senha incorretos" : er.message, true); });
    });
  }
  function loadMe() { return api("me").then(function (m) { S.me = m; return m; }); }

  // ============================================================ estrutura
  var ADMIN_NAV = [["inicio", "Início"], ["clientes", "Clientes"], ["revendedores", "Revendedores"], "Conteúdo",
    ["canais", "Canais"], ["filmes", "Filmes"], ["series", "Séries"], ["categorias", "Categorias"], "Fornecedor",
    ["acessos", "Acessos do fornecedor"], ["importar", "Importar do fornecedor"], "Sistema", ["ajustes", "Ajustes"]];
  var RES_NAV = [["inicio", "Início"], ["clientes", "Clientes"], ["conta", "Minha conta"]];

  function renderShell() {
    var admin = S.me.role === "admin";
    var nav = (admin ? ADMIN_NAV : RES_NAV).map(function (n) {
      return typeof n === "string" ? '<div class="sep">' + esc(n) + "</div>" : '<a href="#' + n[0] + '" data-r="' + n[0] + '">' + esc(n[1]) + "</a>";
    }).join("");
    $("#app").innerHTML =
      '<div class="shell"><aside class="side"><div class="brand"><img src="logo.png" alt=""><div><b>' + esc((S.me.settings && S.me.settings.server_name) || C.brand) +
      '</b><small>' + (admin ? "Administrador" : "Revendedor") + '</small></div></div><nav class="nav">' + nav + '</nav>' +
      '<div class="who">' + esc(S.me.name || S.me.email) + (admin ? "" : '<br>Créditos: <b class="cr">' + (S.me.credits || 0) + "</b>") +
      '<br><a href="#" class="out">Sair</a></div></aside><main class="main"></main></div>';
    $(".out").addEventListener("click", function (e) { e.preventDefault(); logout(); });
  }
  function page(title, actionsHtml) {
    var m = $(".main");
    m.innerHTML = '<div class="top"><button class="btn menu-btn">☰</button><h2>' + esc(title) + "</h2>" + (actionsHtml || "") + '</div><div class="pg"></div>';
    $(".menu-btn", m).addEventListener("click", function () { $(".side").classList.toggle("open"); });
    return $(".pg", m);
  }
  function refreshCredits() {
    if (S.me.role === "admin") return Promise.resolve();
    return api("me").then(function (m) { S.me = m; var c = $(".cr"); if (c) c.textContent = m.credits; });
  }

  // ============================================================ início
  function viewInicio() {
    var admin = S.me.role === "admin";
    var pg = page("Início");
    pg.innerHTML = '<div class="empty">Carregando…</div>';
    api("stats").then(function (s) {
      var cards = [["active", "Clientes ativos"], ["trials", "Testes ativos"], ["expired", "Vencidos"], ["total", "Total de clientes"]];
      var html = "";
      if (admin) {
        var free = s.accounts_total - s.accounts_used;
        if (!s.accounts_total) html += '<div class="alert bad">Nenhum acesso do fornecedor cadastrado. Cadastre em <a href="#acessos">Acessos do fornecedor</a> para poder criar clientes.</div>';
        else if (free <= 0) html += '<div class="alert bad">Todos os acessos do fornecedor estão em uso. Novos clientes e testes vão falhar até você cadastrar mais acessos.</div>';
        else if (free <= Math.max(2, s.accounts_total * 0.1)) html += '<div class="alert">Restam só ' + free + ' acessos livres do fornecedor. Compre mais em breve.</div>';
        cards.push(["accfree", "Acessos livres do fornecedor"], ["resellers", "Revendedores"], ["live", "Canais"], ["movies", "Filmes"], ["series", "Séries"]);
        s.accfree = (s.accounts_total - s.accounts_used) + " / " + s.accounts_total;
      } else {
        cards.unshift(["credits", "Seus créditos"]); s.credits = S.me.credits;
      }
      html += '<div class="cards">' + cards.map(function (c) { return '<div class="card"><div class="n">' + esc(s[c[0]]) + '</div><div class="l">' + c[1] + "</div></div>"; }).join("") + "</div>";
      html += '<div class="box"><b>Como o cliente usa</b><p class="muted small" style="margin:6px 0 0">No <b>BristonPlay</b>: cole o <b>link M3U</b> do cliente no painel do app. Em apps como <b>IPTV Smarters</b> ou <b>XCIPTV</b>: use a opção "Xtream Codes" com o <b>servidor</b>, <b>usuário</b> e <b>senha</b> que aparecem em "Dados" de cada cliente.</p></div>';
      pg.innerHTML = html;
    }).catch(function (e) { pg.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }

  // ============================================================ clientes
  function accessHtml(l) {
    var a = l.access;
    var row = function (label, v) { return '<label>' + label + '</label><div class="copy"><input readonly value="' + esc(v) + '"><button class="btn s" data-copy="' + esc(v) + '">Copiar</button></div>'; };
    return row("Usuário", a.username) + row("Senha", a.password) + row("Servidor (Xtream)", a.server) + row("Link M3U", a.m3u) +
      '<p class="muted small">Vence em: <b>' + fmtDate(l.expires_at, true) + "</b></p>";
  }
  function waText(l) {
    var a = l.access, name = (S.me.settings && S.me.settings.server_name) || C.brand;
    return "*" + name + "*\n\nUsuário: " + a.username + "\nSenha: " + a.password + "\nServidor: " + a.server +
      "\n\nLink M3U:\n" + a.m3u + "\n\nVencimento: " + fmtDate(l.expires_at, true);
  }
  function showAccess(l, title) {
    var m = modal(title || "Dados do cliente", accessHtml(l), [
      { label: "Copiar tudo", onClick: function () { copy(waText(l)); return true; } },
      { label: "Enviar no WhatsApp", onClick: function () { window.open("https://wa.me/?text=" + encodeURIComponent(waText(l)), "_blank"); return true; } },
      { label: "Fechar", primary: true },
    ]);
    $$("[data-copy]", m.el).forEach(function (b) { b.addEventListener("click", function () { copy(b.getAttribute("data-copy")); }); });
  }
  function plansOptions() {
    return (S.me.settings.credit_plans || []).map(function (p) {
      return '<option value="' + p.months + '">' + p.months + (p.months == 1 ? " mês" : " meses") + (S.me.role === "admin" ? "" : " — " + p.credits + " crédito(s)") + "</option>";
    }).join("");
  }

  function viewClientes() {
    var admin = S.me.role === "admin";
    var pg = page("Clientes", '<button class="btn" data-a="trial">+ Teste grátis</button><button class="btn p" data-a="new">+ Novo cliente</button>');
    var st = { page: 0, per: 50, q: "", filter: "", reseller_id: "" };
    pg.innerHTML = '<div class="bar"><input placeholder="Buscar usuário ou observação" class="q"><select class="f"><option value="">Todos</option><option value="active">Ativos</option><option value="trial">Testes</option><option value="expired">Vencidos</option><option value="disabled">Bloqueados</option></select>' +
      (admin ? '<select class="r"><option value="">Todos os donos</option><option value="admin">Administrador</option></select>' : "") +
      '</div><div class="tw"></div><div class="pager"></div>';
    if (admin) api("resellers.list").then(function (r) { $(".r", pg).innerHTML += r.rows.map(function (x) { return '<option value="' + x.id + '">' + esc(x.name) + "</option>"; }).join(""); });
    function load() {
      $(".tw", pg).innerHTML = '<div class="empty">Carregando…</div>';
      api("lines.list", st).then(function (r) {
        if (!r.rows.length) { $(".tw", pg).innerHTML = '<div class="empty">Nenhum cliente encontrado.</div>'; $(".pager", pg).innerHTML = ""; return; }
        $(".tw", pg).innerHTML = "<table><thead><tr><th>Usuário</th><th>Senha</th><th>Vencimento</th><th>Status</th>" + (admin ? "<th>Dono</th>" : "") + "<th>Obs.</th><th></th></tr></thead><tbody>" +
          r.rows.map(function (l, i) {
            return "<tr><td class=mono>" + esc(l.username) + "</td><td class=mono>" + esc(l.password) + "</td><td>" + fmtDate(l.expires_at, true) + "</td><td>" + statusTag(l) + "</td>" +
              (admin ? "<td>" + esc(l.reseller_name) + "</td>" : "") + '<td class="small muted">' + esc(l.notes) + '</td><td><div class="acts">' +
              '<button class="btn s" data-i="' + i + '" data-x="dados">Dados</button><button class="btn s" data-i="' + i + '" data-x="renew">Renovar</button>' +
              '<button class="btn s" data-i="' + i + '" data-x="edit">Editar</button></div></td></tr>';
          }).join("") + "</tbody></table>";
        $$("[data-x]", pg).forEach(function (b) { b.addEventListener("click", function () { act(b.getAttribute("data-x"), r.rows[+b.getAttribute("data-i")]); }); });
        var pages = Math.ceil(r.count / st.per);
        $(".pager", pg).innerHTML = r.count + " cliente(s) · página " + (st.page + 1) + " de " + pages +
          ' <button class="btn s pv"' + (st.page ? "" : " disabled") + '>‹</button><button class="btn s nx"' + (st.page + 1 < pages ? "" : " disabled") + ">›</button>";
        $(".pv", pg).addEventListener("click", function () { st.page--; load(); });
        $(".nx", pg).addEventListener("click", function () { st.page++; load(); });
      }).catch(function (e) { $(".tw", pg).innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }
    function act(x, l) {
      if (x === "dados") return showAccess(l);
      if (x === "renew") {
        return modal("Renovar " + l.username, '<label>Plano</label><select name="months">' + plansOptions() + '</select><p class="muted small">Os meses são somados a partir do vencimento atual (ou de hoje, se já venceu).</p>',
          [{ label: "Cancelar" }, { label: "Renovar", primary: true, onClick: function (el) {
            return api("lines.renew", { id: l.id, months: +val(el, "months") }).then(function (r) { toast("Renovado até " + fmtDate(r.line.expires_at)); refreshCredits(); load(); });
          } }]);
      }
      if (x === "edit") {
        var m = modal("Editar " + l.username,
          '<label>Observação (nome do cliente, telefone…)</label><input name="notes" value="' + esc(l.notes) + '">' +
          '<label>Nova senha (deixe em branco para manter)</label><input name="password" placeholder="' + esc(l.password) + '">' +
          (admin ? '<label>Vencimento</label><input name="expires_at" type="datetime-local" value="' + toLocalInput(l.expires_at) + '">' : "") +
          '<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" class="chk" name="enabled"' + (l.enabled ? " checked" : "") + "> Ativo (desmarque para bloquear)</label>",
          [{ label: "Apagar", danger: true, onClick: function () {
            return new Promise(function (ok) { confirmBox("Apagar cliente", "Apagar " + esc(l.username) + "? Os créditos usados não voltam.", "Apagar", function () {
              return api("lines.delete", { id: l.id }).then(function () { toast("Cliente apagado"); m.close(); load(); ok(true); }); }); });
          } },
          { label: "Cancelar" },
          { label: "Salvar", primary: true, onClick: function (el) {
            var b = { id: l.id, notes: val(el, "notes"), enabled: val(el, "enabled") };
            if (val(el, "password")) b.password = val(el, "password");
            if (admin && val(el, "expires_at")) b.expires_at = new Date(val(el, "expires_at")).toISOString();
            return api("lines.update", b).then(function () { toast("Salvo"); load(); });
          } }]);
      }
    }
    function create(trial) {
      var body = (trial ? '<p class="muted">Teste grátis de <b>' + S.me.settings.trial_hours + " hora(s)</b>.</p>" : '<label>Plano</label><select name="months">' + plansOptions() + "</select>") +
        '<label>Observação (nome do cliente, telefone…)</label><input name="notes">' +
        '<div class="grid2"><div><label>Usuário (opcional)</label><input name="username" placeholder="automático"></div><div><label>Senha (opcional)</label><input name="password" placeholder="automática"></div></div>';
      modal(trial ? "Novo teste grátis" : "Novo cliente", body, [{ label: "Cancelar" }, { label: trial ? "Criar teste" : "Criar cliente", primary: true, onClick: function (el) {
        var b = { trial: trial, notes: val(el, "notes"), username: val(el, "username"), password: val(el, "password") };
        if (!trial) b.months = +val(el, "months");
        return api("lines.create", b).then(function (r) { refreshCredits(); load(); showAccess(r.line, trial ? "Teste criado" : "Cliente criado"); });
      } }]);
    }
    $('[data-a="trial"]').addEventListener("click", function () { create(true); });
    $('[data-a="new"]').addEventListener("click", function () { create(false); });
    $(".q", pg).addEventListener("input", debounce(function (e) { st.q = e.target.value; st.page = 0; load(); }, 350));
    $(".f", pg).addEventListener("change", function (e) { st.filter = e.target.value; st.page = 0; load(); });
    if (admin) $(".r", pg).addEventListener("change", function (e) { st.reseller_id = e.target.value; st.page = 0; load(); });
    load();
  }
  function toLocalInput(iso) {
    var d = new Date(iso), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // ============================================================ revendedores (admin)
  function viewRevendedores() {
    var pg = page("Revendedores", '<button class="btn p" data-a="new">+ Novo revendedor</button>');
    function load() {
      pg.innerHTML = '<div class="empty">Carregando…</div>';
      api("resellers.list").then(function (r) {
        if (!r.rows.length) { pg.innerHTML = '<div class="empty">Nenhum revendedor ainda.</div>'; return; }
        pg.innerHTML = '<div class="tw"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Créditos</th><th>Clientes ativos</th><th>Status</th><th></th></tr></thead><tbody>' +
          r.rows.map(function (x, i) {
            return "<tr><td>" + esc(x.name) + "</td><td>" + esc(x.email) + "</td><td><b>" + x.credits + "</b></td><td>" + x.active_lines + "</td><td>" +
              (x.enabled ? '<span class="tag ok">Ativo</span>' : '<span class="tag bad">Bloqueado</span>') + '</td><td><div class="acts">' +
              '<button class="btn s" data-i="' + i + '" data-x="cred">Créditos</button><button class="btn s" data-i="' + i + '" data-x="log">Histórico</button>' +
              '<button class="btn s" data-i="' + i + '" data-x="edit">Editar</button></div></td></tr>';
          }).join("") + "</tbody></table></div>" +
          '<p class="muted small">Link do painel para os revendedores: <span class="mono">' + esc(location.origin + location.pathname) + "</span></p>";
        $$("[data-x]", pg).forEach(function (b) { b.addEventListener("click", function () { act(b.getAttribute("data-x"), r.rows[+b.getAttribute("data-i")]); }); });
      }).catch(function (e) { pg.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }
    function act(x, r) {
      if (x === "cred") {
        return modal("Créditos de " + r.name, '<p class="muted">Saldo atual: <b>' + r.credits + '</b></p><label>Quantidade (use número negativo para remover)</label><input name="delta" type="number" value="10"><label>Motivo</label><input name="reason" placeholder="Ex.: compra de 10 créditos">',
          [{ label: "Cancelar" }, { label: "Aplicar", primary: true, onClick: function (el) {
            return api("resellers.credits", { id: r.id, delta: +val(el, "delta"), reason: val(el, "reason") }).then(function (j) { toast("Novo saldo: " + j.credits); load(); });
          } }]);
      }
      if (x === "log") {
        return api("resellers.log", { id: r.id }).then(function (j) {
          modal("Histórico de " + r.name, j.rows.length ? '<div class="tw"><table><thead><tr><th>Data</th><th>Créditos</th><th>Motivo</th></tr></thead><tbody>' +
            j.rows.map(function (l) { return "<tr><td>" + fmtDate(l.created_at, true) + "</td><td>" + (l.delta > 0 ? "+" : "") + l.delta + "</td><td>" + esc(l.reason) + "</td></tr>"; }).join("") +
            "</tbody></table></div>" : '<div class="empty">Sem movimentação.</div>', null, true);
        });
      }
      if (x === "edit") {
        var m = modal("Editar " + r.name, '<label>Nome</label><input name="name" value="' + esc(r.name) + '"><label>Nova senha (deixe em branco para manter)</label><input name="password" type="text">' +
          '<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" class="chk" name="enabled"' + (r.enabled ? " checked" : "") + "> Ativo</label>",
          [{ label: "Apagar", danger: true, onClick: function () {
            return new Promise(function (ok) { confirmBox("Apagar revendedor", "Apagar " + esc(r.name) + "? Os clientes dele continuam funcionando e passam para o administrador.", "Apagar", function () {
              return api("resellers.delete", { id: r.id }).then(function () { toast("Revendedor apagado"); m.close(); load(); ok(true); }); }); });
          } }, { label: "Cancelar" }, { label: "Salvar", primary: true, onClick: function (el) {
            var b = { id: r.id, name: val(el, "name"), enabled: val(el, "enabled") };
            if (val(el, "password")) b.password = val(el, "password");
            return api("resellers.update", b).then(function () { toast("Salvo"); load(); });
          } }]);
      }
    }
    $('[data-a="new"]').addEventListener("click", function () {
      modal("Novo revendedor", '<label>Nome</label><input name="name"><label>E-mail (login)</label><input name="email" type="email"><label>Senha inicial (mín. 8)</label><input name="password" type="text"><label>Créditos iniciais</label><input name="credits" type="number" value="0">',
        [{ label: "Cancelar" }, { label: "Criar", primary: true, onClick: function (el) {
          return api("resellers.create", { name: val(el, "name"), email: val(el, "email"), password: val(el, "password"), credits: +val(el, "credits") || 0 })
            .then(function () { toast("Revendedor criado"); load(); });
        } }]);
    });
    load();
  }

  // ============================================================ minha conta (revendedor)
  function viewConta() {
    var pg = page("Minha conta");
    pg.innerHTML = '<div class="box"><p>Nome: <b>' + esc(S.me.name) + "</b><br>E-mail: " + esc(S.me.email) + "<br>Créditos: <b>" + S.me.credits + "</b></p>" +
      '<p class="muted small">Para comprar créditos, fale com o administrador.</p></div><div class="box" style="max-width:420px"><b>Trocar senha</b><label>Nova senha (mín. 8)</label><input type="password" name="p1"><label>Repita</label><input type="password" name="p2"><div style="margin-top:12px"><button class="btn p sv">Salvar senha</button></div></div>';
    $(".sv", pg).addEventListener("click", function () {
      var p1 = val(pg, "p1"), p2 = val(pg, "p2");
      if (p1.length < 8) return toast("A senha precisa ter pelo menos 8 caracteres", true);
      if (p1 !== p2) return toast("As senhas não conferem", true);
      token().then(function (tk) {
        return fetch(C.supabaseUrl + "/auth/v1/user", { method: "PUT", headers: { apikey: C.anonKey, Authorization: "Bearer " + tk, "Content-Type": "application/json" }, body: JSON.stringify({ password: p1 }) });
      }).then(function (r) { if (!r.ok) throw new Error("Não foi possível trocar a senha"); toast("Senha alterada"); $$("input", pg).forEach(function (i) { i.value = ""; }); })
        .catch(function (e) { toast(e.message, true); });
    });
  }

  // ============================================================ acessos do fornecedor (admin)
  function viewAcessos() {
    var pg = page("Acessos do fornecedor", '<button class="btn" data-a="bulk">+ Vários de uma vez</button><button class="btn p" data-a="new">+ Novo acesso</button>');
    function load() {
      pg.innerHTML = '<div class="empty">Carregando…</div>';
      api("accounts.list").then(function (r) {
        var html = '<p class="muted small">Cada cliente ativo (ou teste) ocupa uma conexão de um destes acessos. Quando o cliente vence ou é bloqueado, a conexão volta a ficar livre.</p>';
        if (!r.rows.length) { pg.innerHTML = html + '<div class="empty">Nenhum acesso cadastrado.</div>'; return; }
        pg.innerHTML = html + '<div class="tw"><table><thead><tr><th>Nome</th><th>Servidor</th><th>Usuário</th><th>Em uso</th><th>Vence</th><th>Status</th><th></th></tr></thead><tbody>' +
          r.rows.map(function (a, i) {
            var full = a.in_use >= a.max_connections;
            return "<tr><td>" + esc(a.label || "—") + '</td><td class="small mono">' + esc(a.server_url) + '</td><td class="mono">' + esc(a.username) + "</td><td>" +
              '<span class="tag ' + (full ? "warn" : "ok") + '">' + a.in_use + " / " + a.max_connections + "</span></td><td>" + fmtDate(a.expires_at) + "</td><td>" +
              (a.enabled ? '<span class="tag ok">Ativo</span>' : '<span class="tag bad">Desativado</span>') + '</td><td><button class="btn s" data-i="' + i + '">Editar</button></td></tr>';
          }).join("") + "</tbody></table></div>";
        $$("[data-i]", pg).forEach(function (b) { b.addEventListener("click", function () { edit(r.rows[+b.getAttribute("data-i")]); }); });
      }).catch(function (e) { pg.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }
    function edit(a) {
      a = a || { enabled: true, max_connections: 1 };
      var m = modal(a.id ? "Editar acesso" : "Novo acesso",
        '<label>Nome (para você identificar)</label><input name="label" value="' + esc(a.label) + '">' +
        '<label>Endereço do servidor do fornecedor</label><input name="server_url" placeholder="http://servidor.com:8080" value="' + esc(a.server_url) + '">' +
        '<div class="grid2"><div><label>Usuário</label><input name="username" value="' + esc(a.username) + '"></div><div><label>Senha</label><input name="password" value="' + esc(a.password) + '"></div></div>' +
        '<div class="grid2"><div><label>Conexões (telas)</label><input name="max_connections" type="number" min="1" value="' + (a.max_connections || 1) + '"></div><div><label>Vence em (opcional)</label><input name="expires_at" type="date" value="' + (a.expires_at ? a.expires_at.slice(0, 10) : "") + '"></div></div>' +
        '<label>Observação</label><input name="notes" value="' + esc(a.notes) + '">' +
        '<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" class="chk" name="enabled"' + (a.enabled ? " checked" : "") + "> Ativo</label>",
        (a.id ? [{ label: "Apagar", danger: true, onClick: function () {
          return new Promise(function (ok) { confirmBox("Apagar acesso", "Os clientes que usam este acesso passam para outro livre na próxima vez que assistirem.", "Apagar", function () {
            return api("accounts.delete", { id: a.id }).then(function () { m.close(); load(); ok(true); }); }); });
        } }] : []).concat([{ label: "Cancelar" }, { label: "Salvar", primary: true, onClick: function (el) {
          return api("accounts.save", { row: { id: a.id, label: val(el, "label"), server_url: val(el, "server_url"), username: val(el, "username"), password: val(el, "password"),
            max_connections: +val(el, "max_connections") || 1, expires_at: val(el, "expires_at") ? new Date(val(el, "expires_at") + "T23:59:00").toISOString() : null,
            notes: val(el, "notes"), enabled: val(el, "enabled") } }).then(function () { toast("Salvo"); load(); });
        } }]));
    }
    $('[data-a="new"]').addEventListener("click", function () { edit(null); });
    $('[data-a="bulk"]').addEventListener("click", function () {
      modal("Cadastrar vários acessos", '<label>Endereço do servidor (igual para todos)</label><input name="server_url" placeholder="http://servidor.com:8080">' +
        '<label>Acessos — um por linha: <span class="mono">usuario senha</span> (ou cole os links M3U de cada acesso)</label><textarea name="text" style="min-height:160px"></textarea>' +
        '<div class="grid2"><div><label>Conexões por acesso</label><input name="max_connections" type="number" value="1" min="1"></div><div><label>Nome (opcional)</label><input name="label"></div></div>',
        [{ label: "Cancelar" }, { label: "Cadastrar", primary: true, onClick: function (el) {
          var url = val(el, "server_url"), text = $('[name="text"]', el).value;
          if (!url) { var mm = text.match(/(https?:\/\/[^/\s]+)\/get\.php/i); if (mm) url = mm[1]; }
          return api("accounts.bulk", { server_url: url, text: text, max_connections: +val(el, "max_connections") || 1, label: val(el, "label") })
            .then(function (r) { toast(r.added + " acesso(s) cadastrado(s)"); load(); });
        } }]);
    });
    load();
  }

  // ============================================================ importar do fornecedor (admin)
  var ADULT_RE = /(adult|xxx|\+ ?18|18 ?\+|porn|hot|sexy|er[oó]tic)/i;
  var EP_RE = /^(.*?)[\s._-]*S(\d{1,3})[\s._-]*E(\d{1,4})\b/i;
  var EP2_RE = /^(.*?)[\s._-]*(\d{1,2})x(\d{1,3})\b/i;

  function parseM3U(text) {
    var lines = text.split(/\r?\n/), items = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln) continue;
      if (ln.indexOf("#EXTINF") === 0) {
        var comma = ln.lastIndexOf('",') >= 0 ? ln.indexOf(",", ln.lastIndexOf('"')) : ln.indexOf(",");
        var attrs = {}, re = /([\w-]+)="([^"]*)"/g, m;
        while ((m = re.exec(ln))) attrs[m[1].toLowerCase()] = m[2];
        cur = { name: (comma >= 0 ? ln.slice(comma + 1) : "").trim() || attrs["tvg-name"] || "", logo: attrs["tvg-logo"] || "", epg: attrs["tvg-id"] || "", group: attrs["group-title"] || "Sem categoria" };
        continue;
      }
      if (ln[0] === "#") continue;
      if (!cur) continue;
      var path = ln.split("?")[0], seg = path.split("/"), file = seg[seg.length - 1], dot = file.lastIndexOf(".");
      var id = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
      var kind = /\/series\//i.test(path) ? "series" : /\/movie\//i.test(path) ? "movie" : "live";
      if (kind === "live" && /^(mp4|mkv|avi)$/.test(ext)) kind = "movie";
      cur.kind = kind; cur.psid = id; cur.ext = ext || (kind === "live" ? "ts" : "mp4");
      items.push(cur); cur = null;
    }
    return items;
  }

  function viewImportar() {
    var pg = page("Importar do fornecedor");
    pg.innerHTML = '<div class="box"><p class="muted small" style="margin-top:0">Escolha um acesso do fornecedor. O painel baixa a lista dele e você marca quais categorias quer na sua lista. Itens já importados são atualizados (não duplicam).</p>' +
      '<div class="bar"><select class="acc"><option value="">Carregando acessos…</option></select><button class="btn p go">Baixar lista do fornecedor</button></div>' +
      '<p class="muted small" style="margin:14px 0 6px"><b>Ou cole o link da lista completa M3U</b> que o fornecedor mandou (ex.: http://servidor:80/playlist/usuario/senha/m3u_plus ou …/get.php?username=…). O acesso dela é cadastrado sozinho.</p>' +
      '<div class="bar"><input class="url" placeholder="Cole aqui o link da lista do fornecedor" style="flex:1;min-width:220px"><button class="btn p gourl">Ler este link</button></div>' +
      '<div class="st muted small"></div></div><div class="res"></div>';
    api("accounts.list").then(function (r) {
      $(".acc", pg).innerHTML = r.rows.length ? r.rows.map(function (a) { return '<option value="' + a.id + '">' + esc((a.label ? a.label + " — " : "") + a.username + " @ " + a.server_url) + "</option>"; }).join("")
        : '<option value="">Cadastre um acesso primeiro</option>';
    });
    $(".go", pg).addEventListener("click", function () {
      var id = $(".acc", pg).value; if (!id) return toast("Cadastre um acesso do fornecedor primeiro", true);
      var btn = $(".go", pg); btn.disabled = true; $(".st", pg).textContent = "Baixando a lista do fornecedor (pode levar alguns minutos)…"; $(".res", pg).innerHTML = "";
      api("provider.m3u", { account_id: +id }, true).then(function (r) { return r.text(); }).then(function (text) {
        btn.disabled = false;
        gotList(text);
      }).catch(function (e) { btn.disabled = false; $(".st", pg).textContent = ""; toast(e.message, true); });
    });
    $(".gourl", pg).addEventListener("click", function () {
      var url = $(".url", pg).value.trim();
      if (!/^https?:\/\//i.test(url)) return toast("Cole o link completo da lista (começando com http)", true);
      var btn = $(".gourl", pg); btn.disabled = true; $(".st", pg).textContent = "Baixando a lista do link (pode levar alguns minutos)…"; $(".res", pg).innerHTML = "";
      var info = null;
      api("provider.url", { url: url }, true).then(function (r) {
        try { info = JSON.parse(decodeURIComponent(r.headers.get("x-bp-info") || "")); } catch (e) { info = null; }
        return r.text();
      }).then(function (text) {
        btn.disabled = false;
        if (info && info.created) toast("Acesso " + info.username + " cadastrado em Acessos do fornecedor. Ajuste lá o número de conexões dele.");
        gotList(text);
      }).catch(function (e) { btn.disabled = false; $(".st", pg).textContent = ""; toast(e.message, true); });
    });
    function gotList(text) {
      {
        var items = parseM3U(text);
        if (!items.length) { $(".st", pg).textContent = "A lista veio vazia ou num formato desconhecido."; return; }
        $(".st", pg).textContent = items.length + " itens encontrados.";
        showPicker(items);
      }
    }

    function showPicker(items) {
      var groups = { live: {}, movie: {}, series: {} }, order = { live: [], movie: [], series: [] };
      items.forEach(function (it) {
        var g = groups[it.kind][it.group];
        if (!g) { g = groups[it.kind][it.group] = { name: it.group, items: [] }; order[it.kind].push(it.group); }
        g.items.push(it);
      });
      var titles = { live: "Canais ao vivo", movie: "Filmes", series: "Séries (episódios)" };
      var html = "";
      ["live", "movie", "series"].forEach(function (k) {
        if (!order[k].length) return;
        html += '<div class="box"><div class="bar" style="margin:0 0 8px"><b style="flex:1">' + titles[k] + " (" + order[k].length + ' categorias)</b><button class="btn s" data-all="' + k + '">Marcar todas</button><button class="btn s" data-none="' + k + '">Desmarcar</button></div><div class="cats">' +
          order[k].map(function (gname, i) {
            var g = groups[k][gname], adult = ADULT_RE.test(gname);
            return '<label><input type="checkbox" data-k="' + k + '" data-g="' + i + '"' + (adult ? "" : " checked") + "> " + esc(gname) + ' <span class="muted small">(' + g.items.length + ")" + (adult ? " · adulto" : "") + "</span></label>";
          }).join("") + "</div></div>";
      });
      html += '<div class="box"><button class="btn p imp">Importar selecionados</button><div class="progress" style="margin-top:12px;display:none"><i></i></div><div class="ist muted small" style="margin-top:6px"></div></div>';
      var res = $(".res", pg); res.innerHTML = html;
      $$("[data-all]", res).forEach(function (b) { b.addEventListener("click", function () { $$('[data-k="' + b.getAttribute("data-all") + '"]', res).forEach(function (c) { c.checked = true; }); }); });
      $$("[data-none]", res).forEach(function (b) { b.addEventListener("click", function () { $$('[data-k="' + b.getAttribute("data-none") + '"]', res).forEach(function (c) { c.checked = false; }); }); });
      $(".imp", res).addEventListener("click", function () {
        var sel = { live: [], movie: [], series: [] };
        $$("input[data-k]", res).forEach(function (c) { if (c.checked) sel[c.getAttribute("data-k")].push(groups[c.getAttribute("data-k")][order[c.getAttribute("data-k")][+c.getAttribute("data-g")]]); });
        if (!sel.live.length && !sel.movie.length && !sel.series.length) return toast("Marque ao menos uma categoria", true);
        runImport(sel, res);
      });
    }

    function runImport(sel, res) {
      var cats = [], streams = [], seriesMap = {}, seriesList = [], eps = [], seen = {};
      ["live", "movie", "series"].forEach(function (k) {
        sel[k].forEach(function (g, gi) {
          cats.push({ kind: k, name: g.name, ref: g.name, sort: gi, adult: ADULT_RE.test(g.name) });
          g.items.forEach(function (it) {
            var key = k + "|" + it.psid;
            if (seen[key]) return; // o mesmo item em duas categorias do fornecedor: fica só na primeira
            seen[key] = 1;
            if (k !== "series") { streams.push({ kind: k, cat: g.name, name: it.name, logo: it.logo, epg: it.epg, psid: it.psid, ext: it.ext }); return; }
            var m = it.name.match(EP_RE) || it.name.match(EP2_RE);
            var show = m ? m[1].replace(/[\s._-]+$/, "").trim() : it.name, season = m ? +m[2] : 1, ep = m ? +m[3] : 1;
            var ref = (g.name + "|" + show).toLowerCase();
            if (!seriesMap[ref]) { seriesMap[ref] = 1; seriesList.push({ ref: ref, cat: g.name, name: show || it.name, cover: it.logo }); }
            eps.push({ series: ref, season: season, episode: ep, title: it.name, psid: it.psid, ext: it.ext, cover: it.logo });
          });
        });
      });
      var batches = [];
      batches.push({ categories: cats });
      for (var i = 0; i < streams.length; i += 500) batches.push({ streams: streams.slice(i, i + 500) });
      for (i = 0; i < seriesList.length; i += 500) batches.push({ series: seriesList.slice(i, i + 500) });
      for (i = 0; i < eps.length; i += 500) batches.push({ episodes: eps.slice(i, i + 500) });
      var bar = $(".progress", res), fill = $(".progress i", res), st = $(".ist", res), btn = $(".imp", res);
      bar.style.display = "block"; btn.disabled = true;
      var n = 0;
      (function next() {
        if (n >= batches.length) {
          st.textContent = "Pronto! " + streams.length + " canais/filmes, " + seriesList.length + " séries e " + eps.length + " episódios importados."; btn.disabled = false; toast("Importação concluída"); return;
        }
        st.textContent = "Enviando lote " + (n + 1) + " de " + batches.length + "…";
        api("import.batch", batches[n]).then(function () { n++; fill.style.width = Math.round(n / batches.length * 100) + "%"; next(); })
          .catch(function (e) { btn.disabled = false; st.textContent = "Parou no lote " + (n + 1) + ": " + e.message + ". Clique em importar de novo para continuar (não duplica)."; toast(e.message, true); });
      })();
    }
  }

  // ============================================================ catálogo (admin)
  function loadCats(kind) {
    return api("catalog.list", { table: "categories", kind: kind, per: 500 }).then(function (r) { return r.rows; });
  }
  function catOptions(cats, sel, withAll) {
    return (withAll ? '<option value="">Todas as categorias</option><option value="none"' + (sel === "none" ? " selected" : "") + ">Sem categoria</option>" : '<option value="">— sem categoria —</option>') +
      cats.map(function (c) { return '<option value="' + c.id + '"' + (String(sel) === String(c.id) ? " selected" : "") + ">" + esc(c.name) + (c.enabled ? "" : " (oculta)") + "</option>"; }).join("");
  }

  function viewStreams(kind) {
    var live = kind === "live", tbl = "streams";
    var pg = page(live ? "Canais" : "Filmes", '<button class="btn p" data-a="new">+ ' + (live ? "Novo canal" : "Novo filme") + "</button>");
    var st = { page: 0, per: 50, q: "", category_id: "" }, cats = [], rows = [];
    pg.innerHTML = '<div class="bar"><input class="q" placeholder="Buscar pelo nome"><select class="c"></select></div>' +
      '<div class="bar bulk" style="display:none"><span class="muted small sel"></span><select class="mv"></select><button class="btn s mvb">Mover</button><button class="btn s on">Mostrar</button><button class="btn s off">Ocultar</button><button class="btn s d del">Apagar</button></div>' +
      '<div class="tw"></div><div class="pager"></div>';
    loadCats(kind).then(function (c) { cats = c; $(".c", pg).innerHTML = catOptions(cats, "", true); $(".mv", pg).innerHTML = '<option value="">Mover para…</option>' + catOptions(cats, ""); load(); });
    function selected() { return $$(".ck:checked", pg).map(function (c) { return rows[+c.getAttribute("data-i")].id; }); }
    function upd() { var n = selected().length; $(".bulk", pg).style.display = n ? "flex" : "none"; $(".sel", pg).textContent = n + " selecionado(s)"; }
    function load() {
      $(".tw", pg).innerHTML = '<div class="empty">Carregando…</div>';
      api("catalog.list", Object.assign({ table: tbl, kind: kind }, st)).then(function (r) {
        rows = r.rows; upd();
        var cn = {}; cats.forEach(function (c) { cn[c.id] = c.name; });
        if (!rows.length) { $(".tw", pg).innerHTML = '<div class="empty">Nada por aqui. Use "Importar do fornecedor" ou cadastre manualmente.</div>'; $(".pager", pg).innerHTML = ""; return; }
        $(".tw", pg).innerHTML = '<table><thead><tr><th><input type="checkbox" class="chk all"></th><th></th><th>Nome</th><th>Categoria</th><th>Ordem</th><th>Status</th><th></th></tr></thead><tbody>' +
          rows.map(function (s, i) {
            return '<tr><td><input type="checkbox" class="chk ck" data-i="' + i + '"></td><td>' + (s.logo ? '<img class="thumb' + (live ? "" : " v") + '" loading="lazy" src="' + esc(s.logo) + '" onerror="this.style.visibility=\'hidden\'">' : "") +
              "</td><td>" + esc(s.name) + "</td><td>" + esc(cn[s.category_id] || "—") + "</td><td>" + s.sort + "</td><td>" + (s.enabled ? '<span class="tag ok">Visível</span>' : '<span class="tag bad">Oculto</span>') +
              '</td><td><button class="btn s" data-e="' + i + '">Editar</button></td></tr>';
          }).join("") + "</tbody></table>";
        $$("[data-e]", pg).forEach(function (b) { b.addEventListener("click", function () { edit(rows[+b.getAttribute("data-e")]); }); });
        $$(".ck", pg).forEach(function (c) { c.addEventListener("change", upd); });
        $(".all", pg).addEventListener("change", function (e) { $$(".ck", pg).forEach(function (c) { c.checked = e.target.checked; }); upd(); });
        var pages = Math.ceil(r.count / st.per);
        $(".pager", pg).innerHTML = r.count + " item(ns) · página " + (st.page + 1) + " de " + pages + ' <button class="btn s pv"' + (st.page ? "" : " disabled") + '>‹</button><button class="btn s nx"' + (st.page + 1 < pages ? "" : " disabled") + ">›</button>";
        $(".pv", pg).addEventListener("click", function () { st.page--; load(); });
        $(".nx", pg).addEventListener("click", function () { st.page++; load(); });
      }).catch(function (e) { $(".tw", pg).innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }
    function bulk(op, patch, msg) {
      var ids = selected(); if (!ids.length) return;
      var run = function () { return api("catalog.bulk", { table: tbl, ids: ids, op: op, patch: patch }).then(function () { toast(msg); load(); }); };
      if (op === "delete") confirmBox("Apagar", "Apagar " + ids.length + " item(ns)?", "Apagar", run); else run().catch(function (e) { toast(e.message, true); });
    }
    function edit(s) {
      s = s || { kind: kind, enabled: true, sort: 0, ext: live ? "ts" : "mp4" };
      var m = modal(s.id ? "Editar" : (live ? "Novo canal" : "Novo filme"),
        '<label>Nome</label><input name="name" value="' + esc(s.name) + '">' +
        '<label>Categoria</label><select name="category_id">' + catOptions(cats, s.category_id) + "</select>" +
        '<label>' + (live ? "Logo (URL da imagem)" : "Capa (URL da imagem)") + '</label><input name="logo" value="' + esc(s.logo) + '">' +
        '<div class="grid2"><div><label>ID no fornecedor</label><input name="provider_stream_id" value="' + esc(s.provider_stream_id) + '"></div><div><label>Extensão</label><input name="ext" value="' + esc(s.ext) + '"></div></div>' +
        '<label>Ou link próprio (opcional — use {server}, {user} e {pass} para o acesso do cliente)</label><input name="custom_url" value="' + esc(s.custom_url) + '">' +
        (live ? '<label>ID do guia (EPG)</label><input name="epg_id" value="' + esc(s.epg_id) + '">' :
          '<div class="grid2"><div><label>Ano</label><input name="year" value="' + esc(s.year) + '"></div><div><label>Nota (0 a 10)</label><input name="rating" value="' + esc(s.rating) + '"></div></div><label>Sinopse</label><textarea name="plot">' + esc(s.plot) + "</textarea>") +
        '<div class="grid2"><div><label>Ordem</label><input name="sort" type="number" value="' + (s.sort || 0) + '"></div><div><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;color:var(--text);margin:8px 0"><input type="checkbox" class="chk" name="enabled"' + (s.enabled ? " checked" : "") + "> Visível</label></div></div>",
        (s.id ? [{ label: "Apagar", danger: true, onClick: function () { return api("catalog.bulk", { table: tbl, ids: [s.id], op: "delete" }).then(function () { toast("Apagado"); load(); }); } }] : [])
          .concat([{ label: "Cancelar" }, { label: "Salvar", primary: true, onClick: function (el) {
            var row = { id: s.id, kind: kind, name: val(el, "name"), category_id: val(el, "category_id") ? +val(el, "category_id") : null, logo: val(el, "logo"),
              provider_stream_id: val(el, "provider_stream_id") || null, ext: val(el, "ext") || (live ? "ts" : "mp4"), custom_url: val(el, "custom_url") || null,
              sort: +val(el, "sort") || 0, enabled: val(el, "enabled") };
            if (live) row.epg_id = val(el, "epg_id"); else { row.year = val(el, "year"); row.rating = val(el, "rating"); row.plot = $('[name="plot"]', el).value; }
            if (!row.provider_stream_id && !row.custom_url) throw new Error("Informe o ID no fornecedor ou um link próprio");
            return api("catalog.save", { table: tbl, row: row }).then(function () { toast("Salvo"); load(); });
          } }]));
    }
    $(".q", pg).addEventListener("input", debounce(function (e) { st.q = e.target.value; st.page = 0; load(); }, 350));
    $(".c", pg).addEventListener("change", function (e) { st.category_id = e.target.value; st.page = 0; load(); });
    $(".mvb", pg).addEventListener("click", function () { var c = $(".mv", pg).value; if (!c) return toast("Escolha a categoria", true); bulk("update", { category_id: +c }, "Movido"); });
    $(".on", pg).addEventListener("click", function () { bulk("update", { enabled: true }, "Agora visível"); });
    $(".off", pg).addEventListener("click", function () { bulk("update", { enabled: false }, "Ocultado"); });
    $(".del", pg).addEventListener("click", function () { bulk("delete", null, "Apagado"); });
    $('[data-a="new"]').addEventListener("click", function () { edit(null); });
  }

  // ------------------------------------------------------------ séries
  function viewSeries() {
    var pg = page("Séries", '<button class="btn p" data-a="new">+ Nova série</button>');
    var st = { page: 0, per: 50, q: "", category_id: "" }, cats = [], rows = [];
    pg.innerHTML = '<div class="bar"><input class="q" placeholder="Buscar série"><select class="c"></select></div>' +
      '<div class="bar bulk" style="display:none"><span class="muted small sel"></span><select class="mv"></select><button class="btn s mvb">Mover</button><button class="btn s on">Mostrar</button><button class="btn s off">Ocultar</button><button class="btn s d del">Apagar</button></div>' +
      '<div class="tw"></div><div class="pager"></div>';
    loadCats("series").then(function (c) { cats = c; $(".c", pg).innerHTML = catOptions(cats, "", true); $(".mv", pg).innerHTML = '<option value="">Mover para…</option>' + catOptions(cats, ""); load(); });
    function selected() { return $$(".ck:checked", pg).map(function (c) { return rows[+c.getAttribute("data-i")].id; }); }
    function upd() { var n = selected().length; $(".bulk", pg).style.display = n ? "flex" : "none"; $(".sel", pg).textContent = n + " selecionada(s)"; }
    function load() {
      $(".tw", pg).innerHTML = '<div class="empty">Carregando…</div>';
      api("catalog.list", Object.assign({ table: "series" }, st)).then(function (r) {
        rows = r.rows; upd();
        var cn = {}; cats.forEach(function (c) { cn[c.id] = c.name; });
        if (!rows.length) { $(".tw", pg).innerHTML = '<div class="empty">Nenhuma série.</div>'; $(".pager", pg).innerHTML = ""; return; }
        $(".tw", pg).innerHTML = '<table><thead><tr><th><input type="checkbox" class="chk all"></th><th></th><th>Nome</th><th>Categoria</th><th>Status</th><th></th></tr></thead><tbody>' +
          rows.map(function (s, i) {
            return '<tr><td><input type="checkbox" class="chk ck" data-i="' + i + '"></td><td>' + (s.cover ? '<img class="thumb v" loading="lazy" src="' + esc(s.cover) + '" onerror="this.style.visibility=\'hidden\'">' : "") +
              "</td><td>" + esc(s.name) + "</td><td>" + esc(cn[s.category_id] || "—") + "</td><td>" + (s.enabled ? '<span class="tag ok">Visível</span>' : '<span class="tag bad">Oculta</span>') +
              '</td><td><div class="acts"><button class="btn s" data-ep="' + i + '">Episódios</button><button class="btn s" data-e="' + i + '">Editar</button></div></td></tr>';
          }).join("") + "</tbody></table>";
        $$("[data-e]", pg).forEach(function (b) { b.addEventListener("click", function () { edit(rows[+b.getAttribute("data-e")]); }); });
        $$("[data-ep]", pg).forEach(function (b) { b.addEventListener("click", function () { episodes(rows[+b.getAttribute("data-ep")]); }); });
        $$(".ck", pg).forEach(function (c) { c.addEventListener("change", upd); });
        $(".all", pg).addEventListener("change", function (e) { $$(".ck", pg).forEach(function (c) { c.checked = e.target.checked; }); upd(); });
        var pages = Math.ceil(r.count / st.per);
        $(".pager", pg).innerHTML = r.count + " série(s) · página " + (st.page + 1) + " de " + pages + ' <button class="btn s pv"' + (st.page ? "" : " disabled") + '>‹</button><button class="btn s nx"' + (st.page + 1 < pages ? "" : " disabled") + ">›</button>";
        $(".pv", pg).addEventListener("click", function () { st.page--; load(); });
        $(".nx", pg).addEventListener("click", function () { st.page++; load(); });
      }).catch(function (e) { $(".tw", pg).innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }
    function bulk(op, patch, msg) {
      var ids = selected(); if (!ids.length) return;
      var run = function () { return api("catalog.bulk", { table: "series", ids: ids, op: op, patch: patch }).then(function () { toast(msg); load(); }); };
      if (op === "delete") confirmBox("Apagar", "Apagar " + ids.length + " série(s) com todos os episódios?", "Apagar", run); else run().catch(function (e) { toast(e.message, true); });
    }
    function edit(s) {
      s = s || { enabled: true, sort: 0 };
      modal(s.id ? "Editar série" : "Nova série",
        '<label>Nome</label><input name="name" value="' + esc(s.name) + '"><label>Categoria</label><select name="category_id">' + catOptions(cats, s.category_id) + "</select>" +
        '<label>Capa (URL)</label><input name="cover" value="' + esc(s.cover) + '"><div class="grid2"><div><label>Ano</label><input name="year" value="' + esc(s.year) + '"></div><div><label>Nota (0 a 10)</label><input name="rating" value="' + esc(s.rating) + '"></div></div>' +
        '<label>Sinopse</label><textarea name="plot">' + esc(s.plot) + '</textarea><div class="grid2"><div><label>Ordem</label><input name="sort" type="number" value="' + (s.sort || 0) + '"></div><div><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;color:var(--text);margin:8px 0"><input type="checkbox" class="chk" name="enabled"' + (s.enabled ? " checked" : "") + "> Visível</label></div></div>",
        [{ label: "Cancelar" }, { label: "Salvar", primary: true, onClick: function (el) {
          return api("catalog.save", { table: "series", row: { id: s.id, name: val(el, "name"), category_id: val(el, "category_id") ? +val(el, "category_id") : null, cover: val(el, "cover"),
            year: val(el, "year"), rating: val(el, "rating"), plot: $('[name="plot"]', el).value, sort: +val(el, "sort") || 0, enabled: val(el, "enabled") } }).then(function () { toast("Salvo"); load(); });
        } }]);
    }
    function episodes(s) {
      var m = modal("Episódios — " + s.name, '<div class="eps"><div class="empty">Carregando…</div></div>', [{ label: "+ Episódio", onClick: function () { editEp(null); return true; } }, { label: "Fechar", primary: true }], true);
      function loadEps() {
        api("catalog.list", { table: "episodes", series_id: s.id, per: 500 }).then(function (r) {
          var box = $(".eps", m.el);
          if (!r.rows.length) { box.innerHTML = '<div class="empty">Nenhum episódio.</div>'; return; }
          box.innerHTML = '<div class="tw"><table><thead><tr><th>Temp.</th><th>Ep.</th><th>Título</th><th></th></tr></thead><tbody>' +
            r.rows.map(function (e, i) { return "<tr><td>" + e.season + "</td><td>" + e.episode + "</td><td>" + esc(e.title) + '</td><td><button class="btn s" data-i="' + i + '">Editar</button></td></tr>'; }).join("") + "</tbody></table></div>";
          $$("[data-i]", box).forEach(function (b) { b.addEventListener("click", function () { editEp(r.rows[+b.getAttribute("data-i")]); }); });
        });
      }
      function editEp(e) {
        e = e || { season: 1, episode: 1, ext: "mp4" };
        modal(e.id ? "Editar episódio" : "Novo episódio",
          '<div class="grid2"><div><label>Temporada</label><input name="season" type="number" value="' + e.season + '"></div><div><label>Episódio</label><input name="episode" type="number" value="' + e.episode + '"></div></div>' +
          '<label>Título</label><input name="title" value="' + esc(e.title) + '"><div class="grid2"><div><label>ID no fornecedor</label><input name="provider_stream_id" value="' + esc(e.provider_stream_id) + '"></div><div><label>Extensão</label><input name="ext" value="' + esc(e.ext) + '"></div></div>' +
          '<label>Ou link próprio (opcional)</label><input name="custom_url" value="' + esc(e.custom_url) + '">',
          (e.id ? [{ label: "Apagar", danger: true, onClick: function () { return api("catalog.bulk", { table: "episodes", ids: [e.id], op: "delete" }).then(loadEps); } }] : [])
            .concat([{ label: "Cancelar" }, { label: "Salvar", primary: true, onClick: function (el) {
              var row = { id: e.id, series_id: s.id, season: +val(el, "season") || 1, episode: +val(el, "episode") || 1, title: val(el, "title"),
                provider_stream_id: val(el, "provider_stream_id") || null, ext: val(el, "ext") || "mp4", custom_url: val(el, "custom_url") || null };
              if (!row.provider_stream_id && !row.custom_url) throw new Error("Informe o ID no fornecedor ou um link próprio");
              return api("catalog.save", { table: "episodes", row: row }).then(loadEps);
            } }]));
      }
      loadEps();
    }
    $(".q", pg).addEventListener("input", debounce(function (e) { st.q = e.target.value; st.page = 0; load(); }, 350));
    $(".c", pg).addEventListener("change", function (e) { st.category_id = e.target.value; st.page = 0; load(); });
    $(".mvb", pg).addEventListener("click", function () { var c = $(".mv", pg).value; if (!c) return toast("Escolha a categoria", true); bulk("update", { category_id: +c }, "Movido"); });
    $(".on", pg).addEventListener("click", function () { bulk("update", { enabled: true }, "Agora visível"); });
    $(".off", pg).addEventListener("click", function () { bulk("update", { enabled: false }, "Ocultado"); });
    $(".del", pg).addEventListener("click", function () { bulk("delete", null, "Apagado"); });
    $('[data-a="new"]').addEventListener("click", function () { edit(null); });
  }

  // ------------------------------------------------------------ categorias
  function viewCategorias() {
    var pg = page("Categorias", '<button class="btn p" data-a="new">+ Nova categoria</button>');
    var kind = "live", rows = [];
    pg.innerHTML = '<div class="bar"><select class="k"><option value="live">Canais</option><option value="movie">Filmes</option><option value="series">Séries</option></select><span class="muted small">A ordem define a posição no app (menor primeiro).</span></div><div class="tw"></div>';
    function load() {
      $(".tw", pg).innerHTML = '<div class="empty">Carregando…</div>';
      loadCats(kind).then(function (r) {
        rows = r;
        if (!rows.length) { $(".tw", pg).innerHTML = '<div class="empty">Nenhuma categoria.</div>'; return; }
        $(".tw", pg).innerHTML = '<table><thead><tr><th>Ordem</th><th>Nome</th><th>Adulto</th><th>Status</th><th></th></tr></thead><tbody>' +
          rows.map(function (c, i) {
            return "<tr><td>" + c.sort + "</td><td>" + esc(c.name) + "</td><td>" + (c.adult ? '<span class="tag warn">Sim</span>' : "—") + "</td><td>" + (c.enabled ? '<span class="tag ok">Visível</span>' : '<span class="tag bad">Oculta</span>') +
              '</td><td><button class="btn s" data-i="' + i + '">Editar</button></td></tr>';
          }).join("") + "</tbody></table>";
        $$("[data-i]", pg).forEach(function (b) { b.addEventListener("click", function () { edit(rows[+b.getAttribute("data-i")]); }); });
      }).catch(function (e) { $(".tw", pg).innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    }
    function edit(c) {
      c = c || { kind: kind, enabled: true, sort: rows.length, adult: false };
      modal(c.id ? "Editar categoria" : "Nova categoria",
        '<label>Nome</label><input name="name" value="' + esc(c.name) + '"><label>Ordem</label><input name="sort" type="number" value="' + c.sort + '">' +
        '<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" class="chk" name="adult"' + (c.adult ? " checked" : "") + "> Conteúdo adulto (o app pede PIN)</label>" +
        '<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" class="chk" name="enabled"' + (c.enabled ? " checked" : "") + "> Visível</label>",
        (c.id ? [{ label: "Apagar", danger: true, onClick: function () { return api("catalog.bulk", { table: "categories", ids: [c.id], op: "delete" }).then(function () { toast("Apagada (os itens ficam sem categoria)"); load(); }); } }] : [])
          .concat([{ label: "Cancelar" }, { label: "Salvar", primary: true, onClick: function (el) {
            return api("catalog.save", { table: "categories", row: { id: c.id, kind: c.kind, name: val(el, "name"), sort: +val(el, "sort") || 0, adult: val(el, "adult"), enabled: val(el, "enabled") } })
              .then(function () { toast("Salvo"); load(); });
          } }]));
    }
    $(".k", pg).addEventListener("change", function (e) { kind = e.target.value; load(); });
    $('[data-a="new"]').addEventListener("click", function () { edit(null); });
    load();
  }

  // ------------------------------------------------------------ ajustes
  function viewAjustes() {
    var pg = page("Ajustes");
    var s = S.me.settings;
    pg.innerHTML = '<div class="box" style="max-width:560px"><label>Nome do servidor</label><input name="server_name" value="' + esc(s.server_name) + '">' +
      '<div class="grid2"><div><label>Duração do teste grátis (horas)</label><input name="trial_hours" type="number" value="' + s.trial_hours + '"></div>' +
      '<div><label>Máximo de testes por revendedor em 24 h</label><input name="trial_daily_limit" type="number" value="' + s.trial_daily_limit + '"></div></div>' +
      '<label>Planos (meses e quantos créditos custam ao revendedor)</label><div class="plans"></div><button class="btn s addp" style="margin-top:6px">+ Plano</button>' +
      '<div style="margin-top:16px"><button class="btn p sv">Salvar</button></div></div>' +
      '<div class="box" style="max-width:560px"><b>Endereço do servidor (Xtream)</b><div class="copy" style="margin-top:8px"><input readonly value="' + esc(S.me.server) + '"><button class="btn s cp">Copiar</button></div></div>';
    var plans = (s.credit_plans || []).slice();
    function drawPlans() {
      $(".plans", pg).innerHTML = plans.map(function (p, i) {
        return '<div class="grid2" style="margin-bottom:6px"><input type="number" min="1" data-m="' + i + '" value="' + p.months + '" placeholder="Meses"><div style="display:flex;gap:6px"><input type="number" min="0" data-c="' + i + '" value="' + p.credits + '" placeholder="Créditos"><button class="btn s d" data-x="' + i + '">✕</button></div></div>';
      }).join("");
      $$("[data-x]", pg).forEach(function (b) { b.addEventListener("click", function () { plans.splice(+b.getAttribute("data-x"), 1); drawPlans(); }); });
    }
    drawPlans();
    $(".addp", pg).addEventListener("click", function () { readPlans(); plans.push({ months: 1, credits: 1 }); drawPlans(); });
    function readPlans() { plans = plans.map(function (p, i) { return { months: +($('[data-m="' + i + '"]', pg).value) || 1, credits: +($('[data-c="' + i + '"]', pg).value) || 0 }; }); }
    $(".cp", pg).addEventListener("click", function () { copy(S.me.server); });
    $(".sv", pg).addEventListener("click", function () {
      readPlans();
      api("settings.save", { settings: { server_name: val(pg, "server_name"), trial_hours: +val(pg, "trial_hours"), trial_daily_limit: +val(pg, "trial_daily_limit"), credit_plans: plans } })
        .then(function (r) { S.me.settings = r.settings; toast("Ajustes salvos"); }).catch(function (e) { toast(e.message, true); });
    });
  }

  // ============================================================ rotas
  var ROUTES = {
    inicio: viewInicio, clientes: viewClientes, revendedores: viewRevendedores, conta: viewConta, acessos: viewAcessos, importar: viewImportar,
    canais: function () { viewStreams("live"); }, filmes: function () { viewStreams("movie"); }, series: viewSeries, categorias: viewCategorias, ajustes: viewAjustes,
  };
  var ADMIN_ONLY = { revendedores: 1, acessos: 1, importar: 1, canais: 1, filmes: 1, series: 1, categorias: 1, ajustes: 1 };

  function render() {
    if (!S.session) return renderLogin();
    if (!S.me) {
      $("#app").innerHTML = '<div class="empty" style="margin-top:20vh">Carregando…</div>';
      return loadMe().then(render).catch(function (e) { toast(e.message, true); logout(); });
    }
    var r = (location.hash || "#inicio").slice(1);
    if (!ROUTES[r] || (ADMIN_ONLY[r] && S.me.role !== "admin")) r = "inicio";
    if (!$(".shell")) renderShell();
    $$(".nav a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("data-r") === r); });
    $(".side").classList.remove("open");
    S.route = r;
    ROUTES[r]();
  }
  window.addEventListener("hashchange", render);
  S.session = loadSession();
  render();
})();
