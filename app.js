(function () {
  const $ = (id) => document.getElementById(id);
  const fmtBRL = (n) => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fmtInt = (n) => String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  function getViewKey() { try { return localStorage.getItem('bob_view_key') || ''; } catch (_) { return ''; } }
  function setViewKey(k) { try { localStorage.setItem('bob_view_key', k || ''); } catch (_) {} }
  async function needsKey() {
    try { const j = await fetch('/api/auth/config').then((r) => r.json()); return Boolean(j.needsViewKey); }
    catch (_) { return false; }
  }
  async function apiGet(path) {
    const key = getViewKey();
    const u = path + (path.includes('?') ? '&' : '?') + (key ? 'viewKey=' + encodeURIComponent(key) : '');
    const res = await fetch(u);
    if (res.status === 401) throw new Error('senha');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  function drawChart(serie) {
    const canvas = $('chart'); const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1; const w = canvas.clientWidth || 800; const h = 220;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const data = Array.isArray(serie) ? serie : []; const vals = data.map((x) => Number(x.receita || 0));
    const max = Math.max(1, ...vals, 1); const pad = { l: 44, r: 12, t: 16, b: 28 };
    const iw = w - pad.l - pad.r; const ih = h - pad.t - pad.b;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ih * i) / 4; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#6b7385'; ctx.font = '11px sans-serif'; ctx.fillText('R$' + Math.round(max * (1 - i / 4)), 4, y + 4);
    }
    if (!data.length) return;
    const step = iw / Math.max(1, data.length - 1);
    const pts = data.map((d, i) => ({ x: pad.l + i * step, y: pad.t + ih - (Number(d.receita || 0) / max) * ih }));
    const grd = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    grd.addColorStop(0, 'rgba(46,229,157,0.35)'); grd.addColorStop(1, 'rgba(46,229,157,0.02)');
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineTo(pts[pts.length - 1].x, pad.t + ih); ctx.lineTo(pts[0].x, pad.t + ih); ctx.closePath(); ctx.fillStyle = grd; ctx.fill();
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = '#2ee59d'; ctx.lineWidth = 2.5; ctx.stroke();
  }
  async function refresh() {
    const tenant = $('tenantSel').value;
    const q = tenant ? ('?tenant=' + encodeURIComponent(tenant)) : '';
    const data = await apiGet('/api/overview' + q);
    const t = data.totals || {}; const sel = data.selected;
    $('mReceita').textContent = fmtBRL(t.faturamentoTotal);
    $('mPedidos').textContent = fmtInt(t.pedidosAprovados);
    $('mProdutos').textContent = fmtInt(t.produtosEntregues);
    $('mServers').textContent = fmtInt(t.servidoresAtivos);
    const p = data.periodo || sel?.metrics?.periodo || {};
    $('pReceita').textContent = 'Receita: ' + fmtBRL(p.receita);
    $('pPedidos').textContent = 'Pedidos: ' + fmtInt(p.pedidos);
    $('pProdutos').textContent = 'Produtos: ' + fmtInt(p.produtos);
    drawChart(data.serieDiaria || []);
    const pill = $('statusPill');
    if (sel) {
      pill.className = 'pill ' + (sel.status || 'offline');
      pill.textContent = sel.status === 'online' ? '● Online' : sel.status === 'manutencao' ? '● Manutenção' : '● Offline';
      $('nomeLoja').textContent = sel.nome || 'Dashboard';
      if (sel.avatar) { $('botAvatar').src = sel.avatar; $('botAvatar').style.display = 'block'; }
    } else {
      const anyOnline = (data.tenants || []).some((x) => x.status === 'online');
      const anyM = (data.tenants || []).some((x) => x.status === 'manutencao');
      const st = anyOnline ? 'online' : anyM ? 'manutencao' : 'offline';
      pill.className = 'pill ' + st;
      pill.textContent = st === 'online' ? '● Online' : st === 'manutencao' ? '● Manutenção' : '● Offline';
      $('nomeLoja').textContent = 'Todas as lojas';
      $('botAvatar').style.display = 'none';
    }
    const selEl = $('tenantSel'); const cur = selEl.value;
    selEl.innerHTML = '<option value="">Todas as lojas</option>';
    (data.tenants || []).forEach((x) => {
      const o = document.createElement('option'); o.value = x.id; o.textContent = (x.nome || x.id) + ' (' + x.status + ')'; selEl.appendChild(o);
    });
    selEl.value = cur;
    const box = $('tenantList'); box.innerHTML = '';
    (data.tenants || []).forEach((x) => {
      const el = document.createElement('div'); el.className = 'tenant';
      el.innerHTML = '<span><strong>' + (x.nome || x.id) + '</strong><br><span class="muted">' + (x.id || '') + '</span></span><span class="pill ' + x.status + '">' + x.status + '</span>';
      el.onclick = () => { $('tenantSel').value = x.id; refresh(); };
      box.appendChild(el);
    });
  }
  async function boot() {
    const need = await needsKey();
    if (need) {
      if (!getViewKey()) {
        $('gate').style.display = 'grid'; $('appMain').style.display = 'none'; return;
      }
      try { await apiGet('/api/overview'); }
      catch (_) { $('gate').style.display = 'grid'; $('appMain').style.display = 'none'; return; }
    }
    $('gate').style.display = 'none'; $('appMain').style.display = 'block';
    refresh(); setInterval(refresh, 15000);
  }
  $('btnViewLogin').onclick = async () => {
    setViewKey($('viewKeyInput').value.trim());
    try {
      await apiGet('/api/overview');
      $('gate').style.display = 'none'; $('appMain').style.display = 'block'; $('gateMsg').textContent = '';
      refresh(); setInterval(refresh, 15000);
    } catch (_) { $('gateMsg').textContent = 'Senha incorreta.'; setViewKey(''); }
  };
  $('tenantSel').onchange = () => refresh();
  window.addEventListener('resize', () => { try { refresh(); } catch (_) {} });
  boot();
})();
