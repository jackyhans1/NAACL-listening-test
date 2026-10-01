(() => {
  'use strict';
  /* 음성 청취 평가 — 서버 없는 정적 페이지. 진행 상황은 이 브라우저(localStorage)에 저장되고,
     마지막에 참가자가 점수 CSV를 내려받아 김지한에게 보낸다. 참여 동의와 참여 조건 확인은 사이트 밖에서 미리 받는다. 조건 정보는 이 파일에도 study.js에도 없다. */

  const study = window.VOX_STUDY;
  const $ = (id) => document.getElementById(id);
  if (!study || !study.groups) {
    document.body.textContent = 'study.js를 찾을 수 없습니다. 저 (김지한)에게 알려 주세요.';
    return;
  }
  const GROUPS = Object.keys(study.groups).sort();
  const STORE = 'voxrift-listening-v1';
  let S = null;                 // 현재 세션
  let memoryOnly = false;       // localStorage를 못 쓰는 환경
  const shownBreaks = new Set();

  const SIM = ['분명히 다른 사람', '대체로 다른 사람', '잘 모르겠음 / 어느 정도 비슷함', '매우 비슷함', '같은 사람으로 들림'];
  const NAT = ['매우 부자연스러움', '부자연스러움', '보통', '자연스러움', '매우 자연스러움'];

  /* ---------- helpers ---------- */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  }
  function screen(name) {
    for (const s of ['intro', 'study', 'complete']) $(`${s}-screen`).hidden = s !== name;
    if (name !== 'study') setProgress(null);
    window.scrollTo(0, 0);
  }
  function stopAll() { document.querySelectorAll('audio').forEach((a) => a.pause()); }
  function render(nodes) { stopAll(); $('study-screen').replaceChildren(...nodes.filter((n) => n != null)); window.scrollTo(0, 0); }
  function key(rater, group) { return `${STORE}:${rater}:${group}`; }
  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { memoryOnly = true; return null; } }
  function save() {
    if (!S) return;
    try { localStorage.setItem(key(S.rater, S.group), JSON.stringify(S)); } catch (_) { memoryOnly = true; }
  }
  function screensOf(group) { return study.groups[group].screens; }
  function nPractice(group) { return screensOf(group).filter((s) => s.p).length; }
  function setProgress(i) {
    const bar = $('progress');
    if (i == null) { bar.hidden = true; return; }
    const n = screensOf(S.group).length, np = nPractice(S.group);
    bar.hidden = false;
    $('progress-text').textContent = i < np ? `연습 ${i + 1} / ${np}` : `평가 ${i - np + 1} / ${n - np}`;
    $('progress-fill').style.width = `${Math.round(100 * i / n)}%`;
  }
  // FNV-1a 32-bit over UTF-8 — lets the researcher detect accidental edits of a row (not a security feature)
  function fnv(text) {
    let x = 0x811c9dc5;
    for (const b of new TextEncoder().encode(text)) { x ^= b; x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(16).padStart(8, '0');
  }

  /* ---------- 오디오 ----------
     Each recording is downloaded completely before its player is shown, then played from memory, so playback
     can no longer stall halfway while the file is still arriving. The next screen's files are fetched ahead. */
  const blobs = new Map();                       // audio id -> Promise<blob URL>
  function loadAudio(id) {
    if (!blobs.has(id)) {
      const p = fetch(`audio/${id}.wav`, { cache: 'force-cache' })
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
        .then((b) => URL.createObjectURL(b));
      p.catch(() => blobs.delete(id));           // allow a retry after a failed download
      blobs.set(id, p);
    }
    return blobs.get(id);
  }
  function keepOnly(ids) {                        // free memory held by screens already passed
    for (const [id, p] of blobs) if (!ids.has(id)) { p.then((u) => URL.revokeObjectURL(u)).catch(() => {}); blobs.delete(id); }
  }
  function player(label, sub, id, onChange) {
    const audio = h('audio', { controls: true, preload: 'auto', hidden: true });
    const st = { plays: 0, full: false };
    const status = h('div', { class: 'heard' }, '음성을 불러오는 중…');
    const retry = h('button', { class: 'btn secondary', type: 'button', hidden: true }, '다시 불러오기');
    const attach = () => {
      status.textContent = '음성을 불러오는 중…'; retry.hidden = true;
      loadAudio(id).then((url) => {
        audio.src = url; audio.hidden = false; status.textContent = '아직 끝까지 듣지 않음';
      }).catch(() => {
        status.textContent = '음성을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 불러오기를 눌러 주세요.';
        retry.hidden = false;
      });
    };
    retry.addEventListener('click', attach);
    audio.addEventListener('play', () => {
      document.querySelectorAll('audio').forEach((a) => { if (a !== audio) a.pause(); });
      st.plays += 1; onChange();
    });
    audio.addEventListener('ended', () => {
      st.full = true; status.textContent = '✓ 끝까지 들음 — 다시 들어도 됩니다'; status.classList.add('yes'); onChange();
    });
    st.node = h('div', { class: 'player' }, h('div', { class: 'player-title' }, label),
      h('div', { class: 'player-sub' }, sub), audio, status, retry);
    attach();
    return st;
  }
  function scale(name, labels, onChange) {
    const wrap = h('div', { class: 'scale', role: 'radiogroup' });
    labels.forEach((lab, k) => {
      const id = `${name}-${k + 1}`;
      wrap.append(h('div', { class: 'opt' },
        h('input', { type: 'radio', name, id, value: String(k + 1), onchange: onChange }),
        h('label', { for: id }, h('b', {}, String(k + 1)), lab)));
    });
    return wrap;
  }
  const picked = (name) => { const e = document.querySelector(`input[name="${name}"]:checked`); return e ? Number(e.value) : null; };
  function prefetch(i) {                          // keep the current and next screen's files in memory
    const all = screensOf(S.group), keep = new Set();
    for (const k of [i - 1, i]) if (all[k]) { keep.add(all[k].r); keep.add(all[k].t); }
    keepOnly(keep);
    const sc = all[i];
    if (sc) for (const id of [sc.r, sc.t]) loadAudio(id).catch(() => {});
  }

  /* ---------- 시작 화면 ---------- */
  function initIntro() {
    $('test-banner').hidden = study.mode !== 'test';
    $('minutes').textContent = String(study.estimated_minutes).replace('-', '–');
    $('group').replaceChildren(h('option', { value: '' }, '그룹 선택'),
      ...GROUPS.map((g) => h('option', { value: g }, `그룹 ${g}`)));
    $('setup-form').addEventListener('submit', (ev) => { ev.preventDefault(); start(); });
    $('download-button').addEventListener('click', download);
  }

  function start() {
    const msg = $('setup-message');
    const rater = $('rater-id').value.trim();
    const group = $('group').value;
    if (!rater) { msg.textContent = '평가자 ID를 입력해 주세요.'; return; }
    if (!group) { msg.textContent = '평가 그룹을 선택해 주세요.'; return; }
    msg.textContent = '';
    const prev = load(key(rater, group));
    // resume only on the same site build and mode (a test-site session must never continue as live data)
    if (prev && prev.version === study.version && prev.mode === study.mode && prev.rater === rater && prev.group === group) {
      S = prev;
    } else {
      S = { version: study.version, mode: study.mode, rater, group, schedule: study.groups[group].schedule_id,
            startedAt: new Date().toISOString(), answers: {}, next: 0, finished: false };
      save();
    }
    if (S.finished) return complete();
    screen('study');
    if (S.next === 0) return volumeCheck();
    render([h('div', { class: 'card' }, h('h1', {}, '이어서 진행합니다'),
      h('p', {}, `저장된 답이 있습니다. ${screensOf(group).length}개 화면 중 ${S.next + 1}번째부터 이어서 합니다.`),
      h('p', { class: 'muted' }, '음량이 처음과 같은지 확인해 주세요.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => run(S.next) }, '계속하기')))]);
  }

  function volumeCheck() {
    const next = h('button', { class: 'btn', disabled: true }, '음량을 맞췄습니다 — 계속');
    const p = player('음량 확인', '재생하면서 기기 음량을 조절하세요', screensOf(S.group)[0].r,
      () => { if (p.plays > 0) next.disabled = false; });
    next.addEventListener('click', () => run(0));
    render([h('div', { class: 'card' }, h('h1', {}, '음량 맞추기'),
      h('p', {}, '녹음을 재생하고, 말소리가 분명하게 들리면서 편한 크기로 기기 음량을 맞춰 주세요. ' +
        '평가가 끝날 때까지 음량은 바꾸지 말아 주세요.'), p.node, h('div', { class: 'actions' }, next))]);
  }

  function interstitial(title, lines, then) {
    setProgress(null);
    render([h('div', { class: 'card' }, h('h1', {}, title), ...lines.map((l) => h('p', {}, l)),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: then }, '계속하기')))]);
  }

  function run(i) {
    const all = screensOf(S.group), np = nPractice(S.group);
    if (i >= all.length) return complete();
    const rated = i - np;
    if (rated === 0 && !shownBreaks.has('practice')) {
      shownBreaks.add('practice');
      return interstitial('연습이 끝났습니다', ['이제 본 평가가 시작됩니다. 방법은 연습과 똑같습니다.',
        '각 화면을 독립적으로, 집중해서 들어 주세요.'], () => run(i));
    }
    if (rated > 0 && study.breaks_after_rated.includes(rated) && !shownBreaks.has(rated)) {
      shownBreaks.add(rated);
      return interstitial('잠시 쉬어 가세요', ['1–2분 정도 귀를 쉬게 한 뒤 계속해 주세요.',
        '진행 상황은 저장되어 있습니다. 음량은 그대로 두세요.'], () => run(i));
    }
    trial(i);
  }

  function trial(i) {
    const sc = screensOf(S.group)[i];
    setProgress(i);
    prefetch(i + 1);
    const t0 = performance.now(), startedAt = new Date().toISOString();
    const nextBtn = h('button', { class: 'btn' }, i === screensOf(S.group).length - 1 ? '평가 완료' : '다음');
    const hint = h('span', { class: 'hint' });
    const update = () => {
      const miss = [];
      if (!ref.full) miss.push('기준 음성을 끝까지 듣기');
      if (!test.full) miss.push('평가 음성을 끝까지 듣기');
      if (picked('sim') == null) miss.push('질문 1 답하기');
      if (picked('nat') == null) miss.push('질문 2 답하기');
      nextBtn.disabled = miss.length > 0;
      hint.textContent = miss.length ? `남은 것: ${miss.join(', ')}` : '';
    };
    const ref = player('① 기준 음성', '실제 사람의 녹음입니다', sc.r, update);
    const test = player('② 평가 음성', '이 녹음을 평가합니다', sc.t, update);
    nextBtn.addEventListener('click', () => {
      if (nextBtn.disabled) return;
      nextBtn.disabled = true;
      S.answers[i] = { sim: picked('sim'), nat: picked('nat'), refPlays: ref.plays, testPlays: test.plays,
        refFull: ref.full, testFull: test.full, start: startedAt, submit: new Date().toISOString(),
        elapsed: Math.round(performance.now() - t0) };
      S.next = i + 1;
      save();
      run(i + 1);
    });
    render([
      sc.p ? h('p', {}, h('span', { class: 'tag' }, '연습 — 점수에 포함되지 않음')) : null,
      memoryOnly ? h('p', { class: 'error' }, '이 브라우저는 진행 저장을 허용하지 않습니다. 창을 닫지 말고 끝까지 진행해 주세요.') : null,
      h('div', { class: 'audio-row' }, ref.node, test.node),
      h('p', { class: 'muted small' }, '음성이 끊겨 들리면 다시 재생해 주세요. 다시 재생하면 제대로 들을 수 있습니다.'),
      h('div', { class: 'card' },
        h('div', { class: 'question' },
          h('div', { class: 'q-title' }, '질문 1. 평가 음성이 기준 음성의 화자와 같은 사람의 목소리처럼 들리나요?'),
          h('div', { class: 'q-help' }, '목소리만 비교하세요. 말하는 단어와 음질은 무시합니다.'),
          scale('sim', SIM, update)),
        h('div', { class: 'question' },
          h('div', { class: 'q-title' }, '질문 2. 평가 음성이 사람의 말처럼 자연스럽게 들리나요?'),
          h('div', { class: 'q-help' }, '누구의 목소리인지와는 따로, 잡음·끊김·기계음 느낌을 판단하세요.'),
          scale('nat', NAT, update)),
        h('div', { class: 'actions' }, nextBtn, hint))]);
    update();
  }

  function complete() {
    S.finished = true; save();
    const n = Object.keys(S.answers).length;
    $('complete-copy').textContent = `평가자 ${S.rater} · 그룹 ${S.group} — 화면 ${n}개의 점수가 이 브라우저에 저장되었습니다. ` +
      '아래 버튼으로 CSV를 내려받아 저 (김지한)에게 보내 주세요.';
    screen('complete');
  }

  /* ---------- CSV ---------- */
  const COLS = ['site_version', 'site_mode', 'rater_id', 'group', 'schedule_id', 'screen_index', 'is_practice',
    'reference_audio_id', 'test_audio_id', 'similarity', 'naturalness', 'reference_play_count', 'test_play_count',
    'reference_heard_full', 'test_heard_full', 'trial_start_time', 'submit_time', 'trial_elapsed_ms',
    'session_started_at', 'row_check'];
  function download() {
    const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [COLS];
    screensOf(S.group).forEach((sc, i) => {
      const a = S.answers[i];
      if (!a) return;
      const check = fnv([S.rater, S.group, i, sc.r, sc.t, a.sim, a.nat].join('|'));
      rows.push([study.version, S.mode, S.rater, S.group, S.schedule, i, sc.p ? 1 : 0, sc.r, sc.t, a.sim, a.nat,
        a.refPlays, a.testPlays, a.refFull ? 1 : 0, a.testFull ? 1 : 0, a.start, a.submit, a.elapsed,
        S.startedAt, check]);
    });
    const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `voxrift_listening_${S.rater.replace(/[\\/:*?"<>|\s]+/g, '_')}_group${S.group}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  initIntro();
})();
