
    import { SUPABASE_CONFIG } from "./supabase-config.js";

    const sb = supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
      realtime: { params: { eventsPerSecond: 10 } }
    });

    const CARDS = ['?', '0.5', '1', '2', '3', '5', '8', '13', '☕'];

    let uid = localStorage.getItem('pp_uid');
    if (!uid) { uid = crypto.randomUUID(); localStorage.setItem('pp_uid', uid); }

    let roomId = null;
    let myName = '';
    let myRole = 'participant';
    let channel = null;
    let syncTimer = null;

    /* локальное состояние комнаты, собирается из таблиц rooms/votes/participants */
    const participants = {}; // uid -> {name, role}
    const votes = {};        // uid -> {name, value}
    let room = { status: 'idle', timer: null, result: null };
    const flipped = {};
    const placed = {};
    let lastTimerStart = 0;
    let lastTimerEnded = false;
    let audioCtx = null;

    /* ---------- утилиты ---------- */

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const makeCode = n => {
      const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let s = '';
      for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
      return s;
    };

    function showError(id, text) {
      const el = document.getElementById(id);
      if (!text) { el.classList.add('hidden'); return; }
      el.textContent = text;
      el.classList.remove('hidden');
    }

    const cardFace = (v, hearts) =>
      '<span class="corner tl">' + (hearts ? '♥' : '♠') + '</span>' +
      '<span class="corner br">' + (hearts ? '♥' : '♠') + '</span>' +
      (v === '☕' ? '<span class="coffee">☕</span>' : '<span class="val">' + esc(v) + '</span>');

    /* ---------- вход ---------- */

    function requireName() {
      myName = document.getElementById('nameInput').value.trim();
      if (!myName) { showError('landingMsg', 'Введите ваше имя.'); return false; }
      return true;
    }

    async function createRoom() {
      if (!requireName()) return;
      roomId = makeCode(6);
      await sb.from('rooms').upsert(
        { id: roomId, status: 'idle', created_at: Date.now() },
        { onConflict: 'id', ignoreDuplicates: true });
      await enterRoom();
    }

    async function joinByCode() {
      if (!requireName()) return;
      const code = document.getElementById('joinInput').value.trim().toUpperCase();
      if (!code) { showError('landingMsg', 'Введите код комнаты.'); return; }
      const { data } = await sb.from('rooms').select('id').eq('id', code).maybeSingle();
      if (!data) {
        showError('landingMsg', 'Комната с таким кодом не найдена.');
        return;
      }
      roomId = code;
      await enterRoom();
    }

    async function enterRoom() {
      showError('landingMsg', '');
      const chosenRole = document.getElementById('roleInput').value;

      const { data: existing } = await sb.from('participants')
        .select('uid,role').eq('room_id', roomId);
      const hasHost = (existing || []).some(p => p.role === 'host');

      let role = chosenRole;
      if (!hasHost && (chosenRole === 'host' || Object.keys(existing || {}).length === 0)) {
        role = 'host';
      }
      myRole = role;

      await sb.from('participants').upsert(
        { room_id: roomId, uid, name: myName, role: role, joined_at: Date.now() },
        { onConflict: 'room_id,uid' });

      history.replaceState(null, '', '#' + roomId);
      document.getElementById('landing').classList.add('hidden');
      document.getElementById('room').classList.remove('hidden');
      document.getElementById('roomInfo').classList.remove('hidden');
      document.getElementById('roomCode').textContent = roomId;

      setupSync();
      window.addEventListener('beforeunload', leaveRoomSilent);
    }

    function setupSync() {
      if (channel) { sb.removeChannel(channel); channel = null; }
      channel = sb.channel('room:' + roomId);
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + roomId },
        async () => { await syncRoom(); safeRender(); });
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'votes', filter: 'room_id=eq.' + roomId },
        async () => { await syncVotes(); safeRender(); });
      channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'participants', filter: 'room_id=eq.' + roomId },
        async () => { await syncParts(); safeRender(); });
      channel.subscribe();

      window.clearInterval(syncTimer);
      syncTimer = window.setInterval(() => {
        if (!roomId) return;
        Promise.all([syncParts(), syncVotes(), syncRoom()]).then(safeRender);
      }, 5000);

      Promise.all([syncParts(), syncVotes(), syncRoom()]).then(safeRender);
    }

    async function syncParts() {
      const { data } = await sb.from('participants')
        .select('uid,name,role').eq('room_id', roomId);
      deleteAll(participants);
      (data || []).forEach(p => { participants[p.uid] = { name: p.name, role: p.role }; });
    }

    async function syncVotes() {
      const { data } = await sb.from('votes')
        .select('uid,name,value').eq('room_id', roomId);
      deleteAll(votes);
      (data || []).forEach(v => { votes[v.uid] = { name: v.name, value: v.value }; });
    }

    async function syncRoom() {
      const { data } = await sb.from('rooms')
        .select('id,status,timer,result').eq('id', roomId).maybeSingle();
      const r = data || {};
      room = { status: r.status || 'idle', timer: r.timer || null, result: r.result || null };
      lastTimerStart = (room.timer && room.timer.startAt) || 0;
    }

    const deleteAll = o => { for (const k in o) delete o[k]; };
    const safeRender = () => { try { render(); } catch (e) { console.error('render error:', e); } };

    function leaveRoomSilent() {
      if (roomId && uid) {
        fetch(SUPABASE_CONFIG.url + '/rest/v1/rpc/leave_room', {
          method: 'POST',
          keepalive: true,
          headers: {
            'content-type': 'application/json',
            apikey: SUPABASE_CONFIG.anonKey,
            Authorization: 'Bearer ' + SUPABASE_CONFIG.anonKey
          },
          body: JSON.stringify({ room_id: roomId, uid })
        }).catch(() => {});
      }
    }

    function leaveRoom() {
      leaveRoomSilent();
      teardown();
      history.replaceState(null, '', location.pathname);
      document.getElementById('landing').classList.remove('hidden');
      document.getElementById('room').classList.add('hidden');
      location.reload();
    }

    function teardown() {
      if (channel) { sb.removeChannel(channel); channel = null; }
      window.clearInterval(syncTimer);
      syncTimer = null;
      roomId = null;
      deleteAll(participants); deleteAll(votes);
      room = { status: 'idle', timer: null, result: null };
    }

    function copyLink() {
      navigator.clipboard.writeText(location.href);
    }

    /* ---------- рендер ---------- */

    function render() {
      renderParticipants();
      renderRoundHead();
      renderTimer();
      renderTable();
      renderVoteArea();
      positionTimerRow();
    }

    function positionTimerRow() {
      const row = document.getElementById('timerRow');
      if (!row) return;
      const target = isHost()
        ? document.querySelector('.table-scene')
        : document.getElementById('voteArea');
      if (!target) return;
      const ok = isHost()
        ? row.nextElementSibling === target
        : row.previousElementSibling === target;
      if (!ok) { if (isHost()) target.before(row); else target.after(row); }
      row.classList.toggle('compact', !isHost());
    }

    /* ---------- таймер ---------- */

    const fmtTime = secs => {
      secs = Math.max(0, Math.ceil(secs));
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    };

    function chime(notes, step, vol) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const t0 = audioCtx.currentTime;
        notes.forEach((f, i) => {
          const tt = t0 + i * step;
          [1, 1.006].forEach((mult, k) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.value = f * mult;
            gain.gain.setValueAtTime(0.0001, tt);
            gain.gain.exponentialRampToValueAtTime(vol * (k ? 0.35 : 1), tt + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, tt + 1.1);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(tt);
            osc.stop(tt + 1.3);
          });
        });
      } catch (e) { console.error('audio error:', e); }
    }

    const CHIME_START = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6 — вверх
    const CHIME_END = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1046.5, 1318.5, 1567.98]; // фанфары

    function unlockAudio() {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
      } catch (e) {}
    }
    document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
    document.addEventListener('click', unlockAudio, { once: true });

    function renderTimer() {
      const t = room.timer;
      const controls = document.getElementById('timerControls');
      const row = document.getElementById('timerRow');
      const hasTimer = !!(t && t.endAt);
      controls.innerHTML = '';
      if (!isHost() && !hasTimer && row) row.classList.add('hidden');
      else if (row) row.classList.remove('hidden');
      if (isHost()) {
        if (hasTimer) {
          const b = document.createElement('button');
          b.className = 'btn small';
          b.textContent = 'Стоп';
          b.onclick = stopTimer;
          controls.appendChild(b);
        } else {
          [60, 120, 180, 300, 600].forEach(secs => {
            const b = document.createElement('button');
            b.className = 'btn small ghost';
            b.textContent = (secs / 60) + ' мин';
            b.onclick = () => setTimer(secs);
            controls.appendChild(b);
          });
        }
      }
      tick();
    }

    function setTimer(secs) {
      if (!isHost()) return;
      const now = Date.now();
      sb.from('rooms').update({ timer: { duration: secs, startAt: now, endAt: now + secs * 1000 } })
        .eq('id', roomId);
    }

    function stopTimer() {
      if (!isHost()) return;
      sb.from('rooms').update({ timer: null }).eq('id', roomId);
    }

    function tick() {
      const t = room.timer || null;
      const el = document.getElementById('timerDisplay');
      const timeEl = document.getElementById('timerTime');
      if (!el || !timeEl) return;
      const startAt = t && t.startAt ? t.startAt : 0;
      const active = !!(t && t.endAt);
      el.classList.toggle('hidden', !active);
      if (startAt !== lastTimerStart) {
        lastTimerStart = startAt;
        lastTimerEnded = false;
        if (startAt) chime(CHIME_START, 0.12, 0.22);
      }
      el.classList.remove('ended');
      let text = '—:—';
      if (t && t.endAt) {
        const remain = t.endAt - Date.now();
        if (remain > 0) {
          text = fmtTime(remain / 1000);
        } else {
          text = '0:00';
          el.classList.add('ended');
          if (!lastTimerEnded) {
            lastTimerEnded = true;
            chime(CHIME_END, 0.16, 0.26);
            const endedAt = t.endAt;
            setTimeout(function autoStop() {
              if (room.timer && room.timer.endAt === endedAt && isHost()) {
                sb.from('rooms').update({ timer: null }).eq('id', roomId);
              }
            }, 1600);
          }
        }
      }
      timeEl.textContent = text;
    }
    setInterval(tick, 250);

    function renderParticipants() {
      const list = Object.values(participants).filter(p => p && p.name);
      document.getElementById('pCount').textContent = list.length;
      document.getElementById('participants').innerHTML = list.length
        ? list.map(p => '<span class="chip' + (p.role === 'host' ? ' host' : '') +
            (p.uid === uid ? ' me' : '') + '">' + esc(p.name) +
            (p.role === 'host' ? ' · Ведущий' : '') + (p.uid === uid ? ' · вы' : '') + '</span>').join('')
        : '<span class="hint">Пока никого нет</span>';
    }

    function isHost() {
      const me = participants[uid];
      return !!me && me.role === 'host';
    }

    function participantCount() {
      return Object.values(participants)
        .filter(p => p && p.name && p.role !== 'host').length;
    }

    function validVotes() {
      return Object.entries(votes)
        .filter(([, v]) => v && typeof v.value !== 'undefined')
        .map(([k, v]) => ({ uid: k, name: v.name, value: v.value }));
    }

    function myVote() {
      const v = votes[uid];
      return v && typeof v.value !== 'undefined' ? v.value : null;
    }

    function renderRoundHead() {
      const status = room.status || 'idle';
      const badge = document.getElementById('roundBadge');
      badge.textContent = { idle: 'Ожидает', voting: 'Голосование', done: 'Раскрыто' }[status] || status;
      badge.className = 'badge ' + status;

      const actions = document.getElementById('hostActions');
      let html = '';
      if (isHost()) {
        if (status !== 'voting') html += '<button class="btn small" data-act="start">Начать раунд</button>';
        if (status === 'voting') html += '<button class="btn small" data-act="reveal">Вскрыть карты</button>';
        if (status !== 'idle') html += '<button class="btn small ghost" data-act="reset">Сбросить</button>';
      }
      actions.innerHTML = html;
      actions.querySelectorAll('[data-act]').forEach(b => {
        b.onclick = () => {
          const act = b.dataset.act;
          if (act === 'start') startRound();
          if (act === 'reveal') revealRound();
          if (act === 'reset') resetRound();
        };
      });
    }

    /* ---------- рассадка за столом ---------- */

    function renderTable() {
      const status = room.status || 'idle';
      const res = room.result;
      const reveal = status === 'done';

      if (status === 'idle') { for (const k in flipped) delete flipped[k]; for (const k in placed) delete placed[k]; }

      // за столом только участники, ведущий наблюдает
      const parts = Object.entries(participants)
        .map(([k, p]) => p && p.name ? { uid: k, name: p.name, role: p.role } : null)
        .filter(Boolean)
        .filter(p => p.role !== 'host')
        .sort((a, b) => (a.uid === uid ? -1 : 0) - (b.uid === uid ? -1 : 0));

      // вы сидите снизу, далее по кругу
      const maxRow = 5, maxCol = 3;
      const bottom = parts.slice(0, maxRow);
      const rest = parts.slice(maxRow);
      const top = rest.slice(0, maxRow);
      const sides = rest.slice(maxRow);
      const left = [], right = [];
      sides.forEach((p, i) => (i % 2 === 0 ? left : right).push(p));

      renderSeats('seatsBottom', bottom, false, votes, reveal);
      renderSeats('seatsTop', top, false, votes, reveal);
      renderSeats('seatsLeft', left, true, votes, reveal);
      renderSeats('seatsRight', right, true, votes, reveal);
      renderPot(parts, status, votes, res, reveal);
    }

    const renderSeats = (id, list, vertical, votes, reveal) => {
      document.getElementById(id).innerHTML = list.map(p => seatHtml(p, votes, reveal, vertical)).join('');
    };

    function seatHtml(p, votes, reveal, vertical) {
      const v = votes[p.uid];
      const hasVoted = !!v && typeof v.value !== 'undefined';
      const inHand = !hasVoted;
      const card = inHand
        ? '<div class="scard"><span class="card-inner">' +
          '<span class="card-face">' + cardFace('?', true) + '</span>' +
          '<span class="card-back"></span></span></div>'
        : '<div class="scard empty"></div>';
      return '<div class="seat' + (vertical ? ' vert' : '') + (p.uid === uid ? ' me' : '') + '">' +
        card +
        '<div class="sname">' + esc(p.name) + (p.uid === uid ? ' · вы' : '') + '</div></div>';
    }

    function renderPot(parts, status, votes, res, reveal) {
      const pot = document.getElementById('pot');
      const votedParts = parts.filter(p => {
        const v = votes[p.uid];
        return !!v && typeof v.value !== 'undefined';
      });

      if (!votedParts.length) {
        pot.innerHTML = status === 'done' ? '<div class="pempty">Никто не голосовал</div>' : '';
        return;
      }

      pot.innerHTML = votedParts.map((p, i) => {
        const v = votes[p.uid];
        const shouldFlip = reveal || p.uid === uid;
        const animate = shouldFlip && !flipped[p.uid];
        flipped[p.uid] = shouldFlip;
        const place = !placed[p.uid];
        placed[p.uid] = true;

        let face;
        if (reveal) {
          const r = res && res.votes ? res.votes.find(x => x.uid === p.uid) : null;
          face = cardFace(r ? r.value : '?', true);
        } else {
          face = p.uid === uid
            ? cardFace(v.value, true)
            : '<span class="vmark">✓</span>';
        }
        const delay = reveal && animate ? ' d' + (i * 120) : '';
        return '<div class="potcard' + (place ? ' place' : '') + (shouldFlip ? ' flipped' : '') + (animate ? ' anim' : '') + '">' +
          '<div class="tcard"><span class="card-inner"' + delay + '>' +
          '<span class="card-face">' + face + '</span>' +
          '<span class="card-back"></span>' +
          '</span></div>' +
          '<div class="pname">' + esc(p.name) + '</div></div>';
      }).join('');
    }

    function renderVoteArea() {
      const status = room.status || 'idle';
      const area = document.getElementById('voteArea');
      const votedCount = validVotes().length;
      const pCount = participantCount();

      if (status === 'idle') {
        area.innerHTML = '<div class="hint">' + (isHost()
          ? 'Нажмите «Начать раунд» — участники получат карты.'
          : 'Раунд ещё не начался. Дождитесь ведущего.') + '</div>';
        return;
      }

      if (status === 'voting') {
        if (isHost()) {
          area.innerHTML = '<div class="hint">Проголосовали: <b>' + votedCount + '</b> из ' + pCount +
            '. Карты ложатся на стол.</div>';
          return;
        }

        const mine = myVote();
        const cards = CARDS.map(v => {
          const picked = v === mine;
          return '<button class="pcard' + (picked ? ' picked' : '') + '" data-card="' + esc(v) + '">' +
            cardFace(v, picked) + '</button>';
        }).join('');
        area.innerHTML = '<div class="cards">' + cards + '</div>' +
          '<div class="hint">' + (mine
            ? 'Ваша карта на столе: <b>' + esc(mine) + '</b>' + (mine === '☕' ? ' (пропуск)' : '') + '.'
            : 'Выберите карту — она ляжет на стол.') + '</div>' +
          (mine ? '<div class="mt10"><button class="btn small ghost" id="cancelVoteBtn">Отменить выбор</button></div>' : '') +
          '<div class="hint">Проголосовали: <b>' + votedCount + '</b> из ' + pCount + '</div>';
        area.querySelectorAll('.pcard').forEach(b => {
          b.onclick = () => {
            if (b.dataset.card === mine) cancelVote();
            else castVote(b.dataset.card);
          };
        });
        const cancelBtn = document.getElementById('cancelVoteBtn');
        if (cancelBtn) cancelBtn.onclick = cancelVote;
        return;
      }

      const res = room.result;
      const skips = res && res.votes ? res.votes.filter(x => String(x.value) === '☕') : [];
      let html = '<div class="summary">Итог: <b>' + esc(res && res.summary || '—') + '</b></div>';
      if (skips.length) {
        html += '<div class="hint">Пропустили: ' + skips.map(x => esc(x.name)).join(', ') + ' ☕</div>';
      }
      area.innerHTML = html;
    }

    /* ---------- операции ---------- */

    function startRound() {
      if (!isHost()) return;
      sb.from('votes').delete().eq('room_id', roomId);
      sb.from('rooms').update({ status: 'voting', result: null }).eq('id', roomId);
    }

    function castVote(value) {
      if (isHost()) return;
      sb.from('votes').upsert(
        { room_id: roomId, uid: uid, name: myName, value: value },
        { onConflict: 'room_id,uid' });
    }

    function cancelVote() {
      if (isHost()) return;
      sb.from('votes').delete().eq('room_id', roomId).eq('uid', uid);
    }

    function revealRound() {
      if (!isHost() || (room.status || 'idle') !== 'voting') return;
      const rows = validVotes();
      const summary = computeSummary(rows.map(r => r.value));
      sb.from('rooms').update({
        status: 'done',
        result: { summary: summary, votes: rows }
      }).eq('id', roomId);
    }

    function resetRound() {
      if (!isHost()) return;
      sb.from('votes').delete().eq('room_id', roomId);
      sb.from('rooms').update({ status: 'idle', result: null }).eq('id', roomId);
    }

    function computeSummary(values) {
      const skips = values.filter(v => String(v) === '☕');
      const nums = values.map(v => {
        const s = String(v);
        if (s === '☕') return null;
        if (s === '?') return Infinity;
        const n = parseFloat(s.replace(',', '.'));
        return isNaN(n) ? null : n;
      }).filter(v => v !== null);
      let main;
      if (!nums.length) {
        main = '—';
      } else if (nums.every(v => v === nums[0])) {
        main = fmt(nums[0]) + ' (консенсус)';
      } else {
        nums.sort((a, b) => a - b);
        const mid = Math.floor(nums.length / 2);
        const median = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
        main = fmt(median) + ' (медиана)';
      }
      if (skips.length) main += ', пропуск: ' + skips.length;
      return main;
    }

    const fmt = n => Number.isFinite(n) ? String(n) : '∞';

    /* ---------- вход по ссылке ---------- */

    function initFromHash() {
      const code = (location.hash || '').replace('#', '').trim().toUpperCase();
      if (code) {
        document.getElementById('joinInput').value = code;
        document.getElementById('nameInput').focus();
      }
    }

    /* ---------- привязка кнопок ---------- */

    document.getElementById('createBtn').onclick = createRoom;
    document.getElementById('joinBtn').onclick = joinByCode;
    document.getElementById('copyBtn').onclick = copyLink;
    document.getElementById('leaveBtn').onclick = leaveRoom;

    initFromHash();
  