/* ==========================================================
   SMOKE - 喫煙本数管理アプリ ロジック本体
   MVP範囲: ①+1本 ②取り消し ③今日の本数 ④今週の本数
            ⑤週上限 ⑥カレンダー ⑦日別詳細 ⑧平日/休日設定 ⑨端末保存
   ========================================================== */

(function () {
  "use strict";

  const STORAGE_KEY = "smoke40_data_v1";
  const DOW_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

  // ---------------------------------------------------------
  // データ層（localStorageへの保存・読み込み）
  // ---------------------------------------------------------
  function defaultData() {
    return {
      records: [], // 喫煙1本ごとの記録時刻（epoch ms）の配列。昇順で追加していく
      settings: {
        weeklyLimit: 40,   // 週間上限本数
        weekdayTarget: 5,  // 平日の目安本数
        weekendTarget: 10, // 土日祝の目安本数
        weekStart: 1,      // 週の開始曜日 0=日,1=月,...6=土
      },
    };
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultData();
      const parsed = JSON.parse(raw);
      const def = defaultData();
      if (!parsed || !Array.isArray(parsed.records)) return def;
      return {
        records: parsed.records.filter((v) => typeof v === "number" && Number.isFinite(v)),
        settings: Object.assign({}, def.settings, parsed.settings || {}),
      };
    } catch (e) {
      // 破損データの場合は初期状態にフォールバックする（アプリが起動不能になるのを防ぐ）
      console.error("データ読み込みエラー:", e);
      return defaultData();
    }
  }

  function saveData() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
    } catch (e) {
      console.error("データ保存エラー:", e);
      showToast("保存に失敗しました（容量不足の可能性があります）");
    }
  }

  // ---------------------------------------------------------
  // 日付・週まわりのユーティリティ
  // ---------------------------------------------------------
  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function getWeekStart(date, weekStart) {
    const d = startOfDay(date);
    const diff = (d.getDay() - weekStart + 7) % 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  function getWeekEnd(date, weekStart) {
    const start = getWeekStart(date, weekStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return end;
  }

  // 日本の祝日を計算する（1980〜2099年向けの近似式を使用。年ごとにキャッシュする）
  const holidayCache = new Map();
  function getHolidays(year) {
    if (holidayCache.has(year)) return holidayCache.get(year);

    const holidays = new Map();
    const entries = [];
    const add = (date, name) => {
      if (date.getFullYear() !== year) return;
      holidays.set(dateKey(date), name);
      entries.push({ date });
    };

    add(new Date(year, 0, 1), "元日");
    add(new Date(year, 1, 11), "建国記念の日");
    add(new Date(year, 1, 23), "天皇誕生日");
    add(new Date(year, 3, 29), "昭和の日");
    add(new Date(year, 4, 3), "憲法記念日");
    add(new Date(year, 4, 4), "みどりの日");
    add(new Date(year, 4, 5), "こどもの日");
    add(new Date(year, 7, 11), "山の日");
    add(new Date(year, 10, 3), "文化の日");
    add(new Date(year, 10, 23), "勤労感謝の日");

    // 第n月曜日（ハッピーマンデー）
    const nthMonday = (y, mIdx, n) => {
      const first = new Date(y, mIdx, 1);
      const offset = (8 - first.getDay()) % 7;
      return new Date(y, mIdx, 1 + offset + (n - 1) * 7);
    };
    add(nthMonday(year, 0, 2), "成人の日");
    add(nthMonday(year, 6, 3), "海の日");
    add(nthMonday(year, 8, 3), "敬老の日");
    add(nthMonday(year, 9, 2), "スポーツの日");

    // 春分・秋分（国立天文台の官報告示に基づく近似式。1980〜2099年で有効）
    const base = year - 1980;
    const shunbun = Math.floor(20.8431 + 0.242194 * base - Math.floor(base / 4));
    const shuubun = Math.floor(23.2488 + 0.242194 * base - Math.floor(base / 4));
    add(new Date(year, 2, shunbun), "春分の日");
    add(new Date(year, 8, shuubun), "秋分の日");

    // 国民の休日（前後を祝日に挟まれた、日曜でも祝日でもない平日）
    for (const { date } of entries.slice()) {
      const between = new Date(date);
      between.setDate(date.getDate() + 1);
      const after = new Date(date);
      after.setDate(date.getDate() + 2);
      if (between.getDay() !== 0 && !holidays.has(dateKey(between)) && holidays.has(dateKey(after))) {
        add(between, "国民の休日");
      }
    }

    // 振替休日（日曜と重なる祝日の直後で、最初の非祝日を振替休日にする）
    for (const { date } of entries.slice()) {
      if (date.getDay() === 0) {
        const sub = new Date(date);
        do {
          sub.setDate(sub.getDate() + 1);
        } while (holidays.has(dateKey(sub)));
        add(sub, "振替休日");
      }
    }

    holidayCache.set(year, holidays);
    return holidays;
  }

  function getHolidayName(date) {
    return getHolidays(date.getFullYear()).get(dateKey(date)) || null;
  }

  function isRestDay(date) {
    const dow = date.getDay();
    return dow === 0 || dow === 6 || !!getHolidayName(date);
  }

  function formatMD(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatTime(date) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  // ---------------------------------------------------------
  // 状態
  // ---------------------------------------------------------
  const state = {
    data: loadData(),
    currentView: "home",
    calendarMonth: startOfDay(new Date()), // 表示中の月（1日固定）
    dayDetailDate: null, // 日別詳細で開いている日付（nullなら非表示）
  };

  // ---------------------------------------------------------
  // 集計ヘルパー
  // ---------------------------------------------------------
  function recordsInRange(startMs, endMs) {
    return state.data.records.filter((ts) => ts >= startMs && ts < endMs);
  }

  function recordsOnDay(date) {
    const s = startOfDay(date).getTime();
    const e = s + 24 * 60 * 60 * 1000;
    return recordsInRange(s, e);
  }

  function weekLimitState(count, limit) {
    if (count > limit) return "danger";
    if (count === limit) return "danger";
    if (limit - count <= 5) return "warning";
    return "normal";
  }

  // ---------------------------------------------------------
  // レンダリング: ホーム
  // ---------------------------------------------------------
  function renderHome() {
    const el = document.getElementById("view-home");
    const now = new Date();
    const { settings, records } = state.data;

    const weekStart = getWeekStart(now, settings.weekStart);
    const weekEnd = getWeekEnd(now, settings.weekStart);
    const weekCount = recordsInRange(weekStart.getTime(), weekEnd.getTime()).length;
    const limit = settings.weeklyLimit;
    const remaining = limit - weekCount;
    const percent = Math.min(100, (weekCount / limit) * 100);
    const lvl = weekLimitState(weekCount, limit);

    let badge = "";
    let remainingLine;
    if (weekCount > limit) {
      remainingLine = `<div class="limit-remaining danger">🔴 上限を +${weekCount - limit}本 超過</div>`;
      badge = `<div class="over-note">来週は${limit}本以内を目指しましょう</div>`;
    } else if (weekCount === limit) {
      badge = `<div class="limit-badge">🔴 今週${limit}本に到達</div>`;
      remainingLine = `<div class="limit-remaining danger">残り 0本</div>`;
    } else if (limit - weekCount <= 5) {
      badge = `<div class="limit-badge">⚠️ 今週残り${remaining}本</div>`;
      remainingLine = "";
    } else {
      remainingLine = `<div class="limit-remaining">残り ${remaining}本</div>`;
    }

    const todayRecords = recordsOnDay(now);
    const todayCount = todayRecords.length;
    const todayTarget = isRestDay(now) ? settings.weekendTarget : settings.weekdayTarget;
    const todayOver = todayCount > todayTarget;
    const holidayName = getHolidayName(now);
    const todayLabel = `${formatMD(now)}（${DOW_LABELS[now.getDay()]}）${holidayName ? " ・ " + holidayName : ""}`;

    const dots = todayCount > 0
      ? `<div class="cig-dots">${"🚬".repeat(todayCount)}</div>`
      : `<div class="empty-note">まだ記録がありません</div>`;

    el.innerHTML = `
      <div class="card limit-card">
        ${badge}
        <div class="limit-main">今週 <span class="num">${weekCount}</span> / ${limit}本</div>
        ${remainingLine}
        <div class="progress-track">
          <div class="progress-fill ${lvl}" style="width:${percent}%"></div>
        </div>
      </div>

      <button class="plus-btn" id="btn-add-one">＋ 1本</button>
      <button class="undo-btn" id="btn-undo" ${records.length === 0 ? "disabled" : ""}>最後の1本を取り消す</button>

      <div class="card">
        <div class="today-head">
          <span class="today-count">今日 ${todayCount}本</span>
          <span class="today-target ${todayOver ? "over" : ""}">目安 ${todayTarget}本${todayOver ? "（超過）" : ""}</span>
        </div>
        <div class="today-date">${todayLabel}</div>
        ${dots}
      </div>
    `;

    document.getElementById("btn-add-one").addEventListener("click", handleAddOne);
    const undoBtn = document.getElementById("btn-undo");
    if (!undoBtn.disabled) undoBtn.addEventListener("click", handleUndo);
  }

  function handleAddOne() {
    state.data.records.push(Date.now());
    saveData();
    renderCurrentView();
    showToast("1本記録しました");
  }

  function handleUndo() {
    if (state.data.records.length === 0) return;
    state.data.records.pop();
    saveData();
    renderCurrentView();
    showToast("直前の記録を取り消しました");
  }

  // ---------------------------------------------------------
  // レンダリング: カレンダー
  // ---------------------------------------------------------
  function renderCalendar() {
    const el = document.getElementById("view-calendar");
    const { settings } = state.data;
    const month = state.calendarMonth;
    const year = month.getFullYear();
    const mIdx = month.getMonth();
    const today = startOfDay(new Date());

    const firstDay = new Date(year, mIdx, 1);
    const daysInMonth = new Date(year, mIdx + 1, 0).getDate();
    const leadBlanks = (firstDay.getDay() - settings.weekStart + 7) % 7;

    const dowOrder = [];
    for (let i = 0; i < 7; i++) dowOrder.push((settings.weekStart + i) % 7);

    let cells = "";
    for (let i = 0; i < leadBlanks; i++) {
      cells += `<div class="cal-cell empty"></div>`;
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, mIdx, d);
      const count = recordsOnDay(date).length;
      const rest = isRestDay(date);
      const isToday = date.getTime() === today.getTime();
      const overLimit = count > (rest ? settings.weekendTarget : settings.weekdayTarget);
      const holidayName = getHolidayName(date);

      const cls = ["cal-cell"];
      if (rest) cls.push("rest");
      if (isToday) cls.push("today");
      if (overLimit && count > 0) cls.push("over-limit");

      cells += `
        <button class="${cls.join(" ")}" data-date="${dateKey(date)}" ${holidayName ? `title="${holidayName}"` : ""}>
          ${holidayName ? '<span class="d-dot">●</span>' : ""}
          <span class="d-num">${d}</span>
          <span class="d-count">${count > 0 ? count + "本" : ""}</span>
        </button>
      `;
    }

    el.innerHTML = `
      <div class="cal-header">
        <button id="cal-prev" aria-label="前の月">◀</button>
        <span class="cal-title">${year}年${mIdx + 1}月</span>
        <button id="cal-next" aria-label="次の月">▶</button>
      </div>
      <div class="cal-grid">
        ${dowOrder.map((dw) => `<div class="cal-dow">${DOW_LABELS[dw]}</div>`).join("")}
        ${cells}
      </div>
      <div class="cal-legend">
        <span><span class="legend-swatch" style="background:var(--surface-2)"></span>土日・祝日</span>
        <span><span class="legend-swatch" style="background:var(--danger)"></span>目安超過</span>
        <span>● = 祝日</span>
      </div>
    `;

    document.getElementById("cal-prev").addEventListener("click", () => {
      state.calendarMonth = new Date(year, mIdx - 1, 1);
      renderCalendar();
    });
    document.getElementById("cal-next").addEventListener("click", () => {
      state.calendarMonth = new Date(year, mIdx + 1, 1);
      renderCalendar();
    });
    el.querySelectorAll(".cal-cell[data-date]").forEach((btn) => {
      btn.addEventListener("click", () => openDayDetail(btn.getAttribute("data-date")));
    });
  }

  // ---------------------------------------------------------
  // レンダリング: 日別詳細（下からのシート）
  // ---------------------------------------------------------
  function openDayDetail(key) {
    state.dayDetailDate = key;
    renderDayDetail();
    document.getElementById("day-detail-overlay").classList.add("open");
  }

  function closeDayDetail() {
    document.getElementById("day-detail-overlay").classList.remove("open");
    state.dayDetailDate = null;
  }

  function renderDayDetail() {
    if (!state.dayDetailDate) return;
    const [y, m, d] = state.dayDetailDate.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const today = startOfDay(new Date());
    const isToday = date.getTime() === today.getTime();

    const records = recordsOnDay(date).slice().sort((a, b) => a - b);
    const holidayName = getHolidayName(date);
    const target = isRestDay(date) ? state.data.settings.weekendTarget : state.data.settings.weekdayTarget;

    const list = records.length
      ? `<ul class="sheet-list">${records.map((ts) => `<li>🚬 ${formatTime(new Date(ts))}</li>`).join("")}</ul>`
      : `<p class="empty-note">この日の記録はありません</p>`;

    const sheet = document.getElementById("day-detail-sheet");
    sheet.innerHTML = `
      <div class="sheet-head">
        <span class="sheet-title">${formatMD(date)}（${DOW_LABELS[date.getDay()]}）</span>
        <button class="sheet-close" id="sheet-close-btn" aria-label="閉じる">✕</button>
      </div>
      <div class="sheet-sub">${holidayName ? holidayName + " ・ " : ""}目安 ${target}本</div>
      <div class="sheet-total">合計 ${records.length}本</div>
      ${list}
      ${isToday ? `<button class="plus-btn" id="sheet-add-one">＋ 1本</button>` : ""}
      ${isToday && records.length > 0 ? `<button class="undo-btn" id="sheet-undo">最後の1本を取り消す</button>` : ""}
    `;

    document.getElementById("sheet-close-btn").addEventListener("click", closeDayDetail);
    if (isToday) {
      document.getElementById("sheet-add-one").addEventListener("click", () => {
        handleAddOne();
        renderDayDetail();
      });
      const undoBtn = document.getElementById("sheet-undo");
      if (undoBtn) {
        undoBtn.addEventListener("click", () => {
          handleUndo();
          if (recordsOnDay(date).length === 0) {
            renderDayDetail();
          } else {
            renderDayDetail();
          }
        });
      }
    }
  }

  // ---------------------------------------------------------
  // レンダリング: 設定
  // ---------------------------------------------------------
  function renderSettings() {
    const el = document.getElementById("view-settings");
    const s = state.data.settings;
    const dowOptions = DOW_LABELS.map((label, i) => `<option value="${i}" ${s.weekStart === i ? "selected" : ""}>${label}曜日</option>`).join("");

    el.innerHTML = `
      <div class="section-title">上限・目安</div>
      <div class="card settings-form">
        <div class="field-row">
          <div>
            <div class="field-label">週間上限</div>
            <div class="field-desc">1週間で守りたい本数</div>
          </div>
          <input type="number" id="set-weeklyLimit" min="1" max="999" value="${s.weeklyLimit}">
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">平日目安</div>
            <div class="field-desc">月〜金（祝日は除く）の目安本数</div>
          </div>
          <input type="number" id="set-weekdayTarget" min="0" max="99" value="${s.weekdayTarget}">
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">土日祝目安</div>
            <div class="field-desc">土日・日本の祝日の目安本数</div>
          </div>
          <input type="number" id="set-weekendTarget" min="0" max="99" value="${s.weekendTarget}">
        </div>
      </div>

      <div class="section-title">週の設定</div>
      <div class="card settings-form">
        <div class="field-row">
          <div>
            <div class="field-label">週の開始曜日</div>
            <div class="field-desc">週間集計の起点</div>
          </div>
          <select id="set-weekStart">${dowOptions}</select>
        </div>
      </div>
    `;

    const bindNumber = (id, key, min, max) => {
      const input = document.getElementById(id);
      input.addEventListener("change", () => {
        let v = parseInt(input.value, 10);
        if (!Number.isFinite(v) || v < min) v = min;
        if (v > max) v = max;
        input.value = v;
        state.data.settings[key] = v;
        saveData();
        showToast("保存しました");
        renderCurrentView();
      });
    };
    bindNumber("set-weeklyLimit", "weeklyLimit", 1, 999);
    bindNumber("set-weekdayTarget", "weekdayTarget", 0, 99);
    bindNumber("set-weekendTarget", "weekendTarget", 0, 99);

    document.getElementById("set-weekStart").addEventListener("change", (e) => {
      state.data.settings.weekStart = parseInt(e.target.value, 10);
      saveData();
      showToast("保存しました");
      renderCurrentView();
    });
  }

  // ---------------------------------------------------------
  // 画面切り替え・共通処理
  // ---------------------------------------------------------
  function renderCurrentView() {
    if (state.currentView === "home") renderHome();
    else if (state.currentView === "calendar") renderCalendar();
    else if (state.currentView === "settings") renderSettings();
    if (state.dayDetailDate) renderDayDetail();
  }

  function switchView(view) {
    state.currentView = view;
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById(`view-${view}`).classList.add("active");
    document.querySelectorAll(".nav-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
    renderCurrentView();
  }

  let toastTimer = null;
  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  // ---------------------------------------------------------
  // 初期化
  // ---------------------------------------------------------
  function init() {
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.getAttribute("data-view")));
    });
    document.getElementById("day-detail-backdrop").addEventListener("click", closeDayDetail);

    // アプリをバックグラウンドから復帰した際に日付/週またぎを反映する
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") renderCurrentView();
    });

    switchView("home");

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch((e) => {
          console.error("Service Worker登録エラー:", e);
        });
      });
    }
  }

  init();
})();
