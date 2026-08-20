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
      trackingStartDate: dateKey(new Date()), // 記録開始日（累計集計の起点）"YYYY-MM-DD"
      settings: {
        weeklyLimit: 40,   // 週間上限本数
        weekdayTarget: 5,  // 平日の目安本数
        weekendTarget: 10, // 土日祝の目安本数
        weekStart: 1,      // 週の開始曜日 0=日,1=月,...6=土
        packSize: 20,        // 1箱の本数
        packPrice: 550,      // 1箱の価格（円）
        baselinePerDay: 20,  // 節約計算の基準本数（以前は1日何本吸っていたか）
        morningTarget: 2,    // 午前(0-12時)の目安本数
        afternoonTarget: 2,  // 午後(12-18時)の目安本数
        eveningTarget: 2,    // 夜(18-24時、仕事終わり後)の目安本数
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
      const records = parsed.records.filter((v) => typeof v === "number" && Number.isFinite(v));
      // 記録開始日が未保存の場合、最初の記録の日付から補完する（既存ユーザーの累計集計がズレないように）
      const trackingStartDate = typeof parsed.trackingStartDate === "string"
        ? parsed.trackingStartDate
        : (records.length > 0 ? dateKey(new Date(Math.min(...records))) : def.trackingStartDate);
      return {
        records,
        trackingStartDate,
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
    reductionAmount: 10, // 統計タブの削減シミュレーション用（週あたり本数、保存はしない）
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

  function recordsInMonth(date) {
    const s = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
    const e = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
    return recordsInRange(s, e);
  }

  // 1日を3つの時間帯に分け、指定した時刻がどの時間帯かを返す
  const DAY_PERIODS = [
    { key: "morning", label: "午前", startHour: 0, endHour: 12, settingsKey: "morningTarget" },
    { key: "afternoon", label: "午後", startHour: 12, endHour: 18, settingsKey: "afternoonTarget" },
    { key: "evening", label: "夜", startHour: 18, endHour: 24, settingsKey: "eveningTarget" },
  ];

  function getCurrentPeriod(date) {
    const h = date.getHours();
    return DAY_PERIODS.find((p) => h >= p.startHour && h < p.endHour) || DAY_PERIODS[DAY_PERIODS.length - 1];
  }

  function recordsInPeriod(date, period) {
    const dayStart = startOfDay(date).getTime();
    const s = dayStart + period.startHour * 3600000;
    const e = dayStart + period.endHour * 3600000;
    return recordsInRange(s, e);
  }

  // 記録開始日から現在までに「使ってよかった本数」の累計（時間帯の開始時刻ごとに目安が積み上がる）
  function totalAllowanceSoFar(now, settings) {
    const [y, m, d] = state.data.trackingStartDate.split("-").map(Number);
    const startDate = new Date(y, m - 1, d);
    const todayStart = startOfDay(now);
    const daysBeforeToday = Math.max(0, Math.round((todayStart - startDate) / 86400000));
    const dailyTotal = settings.morningTarget + settings.afternoonTarget + settings.eveningTarget;

    let allowance = daysBeforeToday * dailyTotal;
    const nowHour = now.getHours();
    for (const p of DAY_PERIODS) {
      if (nowHour >= p.startHour) allowance += settings[p.settingsKey];
    }
    return allowance;
  }

  // 貯金残高 = ここまでの目安の累計 − 記録開始日以降の実際の本数（プラスなら貯金、マイナスなら使いすぎ）
  function bankBalance(now) {
    const [y, m, d] = state.data.trackingStartDate.split("-").map(Number);
    const startTs = new Date(y, m - 1, d).getTime();
    const actual = state.data.records.filter((ts) => ts >= startTs).length;
    return totalAllowanceSoFar(now, state.data.settings) - actual;
  }

  // 1日の合計本数を午前/午後/夜の3つになるべく均等に振り分ける（余りは午前から順に+1）
  function distributeDailyTotal(dailyTotal) {
    const base = Math.floor(dailyTotal / 3);
    let remainder = dailyTotal - base * 3;
    const parts = [base, base, base];
    let i = 0;
    while (remainder > 0) {
      parts[i] += 1;
      i = (i + 1) % 3;
      remainder -= 1;
    }
    return { morning: parts[0], afternoon: parts[1], evening: parts[2] };
  }

  // 週間上限 ⇔ 時間帯別目安(午前+午後+夜) を常に一致させる（週間上限=1日の目安合計×7）
  function syncPeriodsFromWeekly() {
    const s = state.data.settings;
    const daily = Math.max(0, Math.round(s.weeklyLimit / 7));
    const { morning, afternoon, evening } = distributeDailyTotal(daily);
    s.morningTarget = morning;
    s.afternoonTarget = afternoon;
    s.eveningTarget = evening;
    s.weeklyLimit = daily * 7; // 7の倍数に達成可能な値としてスナップする
  }

  function syncWeeklyFromPeriods() {
    const s = state.data.settings;
    s.weeklyLimit = (s.morningTarget + s.afternoonTarget + s.eveningTarget) * 7;
  }

  function weekLimitState(count, limit) {
    if (count > limit) return "danger";
    if (count === limit) return "danger";
    if (limit - count <= 5) return "warning";
    return "normal";
  }

  function daysElapsedInWeek(now, weekStart) {
    const start = getWeekStart(now, weekStart);
    const diffDays = Math.floor((startOfDay(now) - start) / 86400000);
    return diffDays + 1; // 週開始日を1日目として数える
  }

  function pricePerCigarette(settings) {
    return settings.packSize > 0 ? settings.packPrice / settings.packSize : 0;
  }

  // 「以前のペース（基準本数/日）」との比較で節約本数・節約金額を計算する
  function calcSavings(days, actualCount, settings) {
    const pricePerCig = pricePerCigarette(settings);
    const baselineCount = settings.baselinePerDay * days;
    const savedCount = baselineCount - actualCount; // 基準を上回った場合は負の値のまま返す（実態を隠さない方針）
    const savedAmount = Math.round(savedCount * pricePerCig);
    return { baselineCount, savedCount, savedAmount };
  }

  // 節約シミュレーション用の期間セット（概算日数）
  const PROJECTION_PERIODS = [
    { label: "1ヶ月", days: 30 },
    { label: "半年", days: 183 },
    { label: "1年", days: 365 },
    { label: "5年", days: 365 * 5 },
    { label: "10年", days: 365 * 10 },
  ];

  function formatInterval(ms) {
    const totalMin = Math.floor(ms / 60000);
    const totalHours = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (totalHours >= 24) {
      const days = Math.floor(totalHours / 24);
      const h = totalHours % 24;
      return `${days}日${h}時間`;
    }
    return totalHours > 0 ? `${totalHours}時間${m}分` : `${m}分`;
  }

  function daysElapsedInMonth(now) {
    return now.getDate(); // 例: 8/15なら「今月15日経過」
  }

  // 指定日("YYYY-MM-DD")から今日までの経過日数（開始日を1日目として数える）
  function daysElapsedSince(dateKeyStr, now) {
    const [y, m, d] = dateKeyStr.split("-").map(Number);
    const start = new Date(y, m - 1, d);
    const diffDays = Math.floor((startOfDay(now) - start) / 86400000);
    return Math.max(1, diffDays + 1);
  }

  function formatSavingsAmount(amount) {
    return amount >= 0
      ? `<span class="savings-positive">¥${amount.toLocaleString()}</span>`
      : `<span class="savings-negative">-¥${Math.abs(amount).toLocaleString()}</span>`;
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

    const lastRecordTs = records.length > 0 ? records[records.length - 1] : null;
    const intervalHtml = lastRecordTs
      ? `<div class="interval-note">前回から ${formatInterval(now.getTime() - lastRecordTs)}</div>`
      : "";

    // 今日の平均喫煙間隔（同日内の連続する記録同士の間隔の平均）
    const todayGaps = [];
    for (let i = 1; i < todayRecords.length; i++) {
      todayGaps.push(todayRecords[i] - todayRecords[i - 1]);
    }
    const todayAvgIntervalHtml = todayGaps.length > 0
      ? `<div class="interval-note">今日の平均間隔 ${formatInterval(todayGaps.reduce((a, b) => a + b, 0) / todayGaps.length)}</div>`
      : "";

    // 現在の時間帯（午前/午後/夜）の消化状況と、時間帯・日をまたいだ貯金残高
    const period = getCurrentPeriod(now);
    const periodCount = recordsInPeriod(now, period).length;
    const periodTarget = settings[period.settingsKey];
    const bank = bankBalance(now);
    const bankOver = bank < 0;
    const periodHtml = `
      <div class="card period-card ${bankOver ? "over" : ""}">
        <div class="period-row">
          <span class="period-label">${period.label}（${period.endHour}時まで）</span>
          <span class="period-count">${periodCount} / ${periodTarget}本</span>
        </div>
        <div class="period-remaining ${bankOver ? "over" : ""}">
          ${bankOver ? `⚠️ 貯金 ${bank}本（${Math.abs(bank)}本使いすぎ）` : `貯金 +${bank}本（${period.endHour}時まで残りとして使えます）`}
        </div>
      </div>
    `;

    const weekDays = daysElapsedInWeek(now, settings.weekStart);
    const savings = calcSavings(weekDays, weekCount, settings);
    const savingsAmountHtml = savings.savedCount >= 0
      ? `<div class="savings-amount positive">節約 ${savings.savedCount}本 ・ ¥${savings.savedAmount.toLocaleString()}</div>`
      : `<div class="savings-amount negative">基準より ${Math.abs(savings.savedCount)}本多い ・ ¥${Math.abs(savings.savedAmount).toLocaleString()}多い計算</div>`;

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

      ${periodHtml}

      <div class="card">
        <div class="today-head">
          <span class="today-count">今日 ${todayCount}本</span>
          <span class="today-target ${todayOver ? "over" : ""}">目安 ${todayTarget}本${todayOver ? "（超過）" : ""}</span>
        </div>
        <div class="today-date">${todayLabel}</div>
        ${intervalHtml}
        ${todayAvgIntervalHtml}
        ${dots}
      </div>

      <div class="card savings-card">
        <div class="savings-title">今週の節約（1日${settings.baselinePerDay}本吸っていた場合と比較）</div>
        <div class="savings-row"><span>以前のペースなら</span><span>${savings.baselineCount}本</span></div>
        <div class="savings-row"><span>実際</span><span>${weekCount}本</span></div>
        ${savingsAmountHtml}
      </div>
    `;

    document.getElementById("btn-add-one").addEventListener("click", () => requestAddOne());
    const undoBtn = document.getElementById("btn-undo");
    if (!undoBtn.disabled) undoBtn.addEventListener("click", handleUndo);
  }

  // forDateを指定すると、その日の正午の記録として追加する（過去日の記録を後から追加する用途）
  function handleAddOne(forDate) {
    const ts = forDate
      ? new Date(forDate.getFullYear(), forDate.getMonth(), forDate.getDate(), 12, 0, 0).getTime()
      : Date.now();
    state.data.records.push(ts);
    state.data.records.sort((a, b) => a - b); // 過去日への追加でも時系列順を保つ（取り消し機能が最後の1件を前提にしているため）
    saveData();
    renderCurrentView();
    showToast("1本記録しました");
  }

  const MINDFUL_CHECK_PROBABILITY = 0.3; // ＋1本のうちランダムでこの割合だけ「本当に吸いたいか」を確認する

  // ＋1本の実行前にランダムで一服前チェックを挟む。afterAddは記録後に実行したい追加処理（画面再描画など）
  // forDateがある場合（過去日への追加）は「今吸いたいか」を問う意味がないためチェックを省略する
  function requestAddOne(afterAdd, forDate) {
    const proceed = () => {
      handleAddOne(forDate);
      if (afterAdd) afterAdd();
    };
    if (!forDate && Math.random() < MINDFUL_CHECK_PROBABILITY) {
      showMindfulCheck(proceed);
    } else {
      proceed();
    }
  }

  function showMindfulCheck(onProceed) {
    const records = state.data.records;
    const lastTs = records.length > 0 ? records[records.length - 1] : null;
    const intervalHtml = lastTs
      ? `<div class="mindful-interval">前回から ${formatInterval(Date.now() - lastTs)}</div>`
      : "";

    const dialog = document.getElementById("mindful-dialog");
    dialog.innerHTML = `
      <div class="mindful-icon">🤔</div>
      <div class="mindful-question">今、本当に吸いたい？</div>
      ${intervalHtml}
      <div class="mindful-sub">食後・コーヒーの後など、"なんとなく"の1本になっていませんか？</div>
      <button class="plus-btn" id="mindful-yes">吸いたい</button>
      <button class="undo-btn" id="mindful-no">やめておく</button>
    `;
    document.getElementById("mindful-overlay").classList.add("open");

    document.getElementById("mindful-yes").addEventListener("click", () => {
      closeMindfulCheck();
      onProceed();
    });
    document.getElementById("mindful-no").addEventListener("click", () => {
      closeMindfulCheck();
      showToast("👍 いい選択です");
    });
  }

  function closeMindfulCheck() {
    document.getElementById("mindful-overlay").classList.remove("open");
  }

  // forDateを指定すると、その日の記録の中で最後の1件だけを取り消す（他の日の記録には影響しない）
  function handleUndo(forDate) {
    if (forDate) {
      const dayStart = startOfDay(forDate).getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      let targetIndex = -1;
      for (let i = state.data.records.length - 1; i >= 0; i--) {
        if (state.data.records[i] >= dayStart && state.data.records[i] < dayEnd) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex === -1) return;
      state.data.records.splice(targetIndex, 1);
    } else {
      if (state.data.records.length === 0) return;
      state.data.records.pop();
    }
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
    const isFuture = date.getTime() > today.getTime();

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
      ${isFuture ? "" : `<button class="plus-btn" id="sheet-add-one">＋ 1本${isToday ? "" : "（この日に追加）"}</button>`}
      ${records.length > 0 ? `<button class="undo-btn" id="sheet-undo">最後の1本を取り消す</button>` : ""}
    `;

    document.getElementById("sheet-close-btn").addEventListener("click", closeDayDetail);
    const addBtn = document.getElementById("sheet-add-one");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        requestAddOne(() => renderDayDetail(), isToday ? undefined : date);
      });
    }
    const undoBtn = document.getElementById("sheet-undo");
    if (undoBtn) {
      undoBtn.addEventListener("click", () => {
        handleUndo(isToday ? undefined : date);
        renderDayDetail();
      });
    }
  }

  // ---------------------------------------------------------
  // レンダリング: 統計（今週・今月・累計）
  // ---------------------------------------------------------
  // 記録の並び（時系列昇順）から、連続する喫煙同士の間隔(時間)の配列を作る
  function computeIntervalGaps() {
    const records = state.data.records;
    const gaps = [];
    for (let i = 1; i < records.length; i++) {
      gaps.push({ ts: records[i], hours: (records[i] - records[i - 1]) / 3600000 });
    }
    return gaps;
  }

  // 日ごとの平均間隔（直近maxDays日分。データが少なければあるだけ返す）
  function averageIntervalByDay(gaps, maxDays) {
    const byDay = new Map();
    for (const g of gaps) {
      const key = dateKey(new Date(g.ts));
      const entry = byDay.get(key) || { sum: 0, count: 0 };
      entry.sum += g.hours;
      entry.count += 1;
      byDay.set(key, entry);
    }
    const rows = Array.from(byDay.entries())
      .map(([key, { sum, count }]) => ({ key, label: key.slice(5).replace("-", "/"), avg: sum / count }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return rows.slice(-maxDays);
  }

  // 月ごとの平均間隔と、各月末時点までの累計平均（徐々に均される推移）
  function monthlyAndCumulativeInterval(gaps) {
    const byMonth = new Map();
    for (const g of gaps) {
      const d = new Date(g.ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const entry = byMonth.get(key) || { sum: 0, count: 0 };
      entry.sum += g.hours;
      entry.count += 1;
      byMonth.set(key, entry);
    }
    const months = Array.from(byMonth.entries())
      .map(([key, { sum, count }]) => ({ key, label: `${Number(key.slice(5))}月`, avg: sum / count }))
      .sort((a, b) => a.key.localeCompare(b.key));

    const sortedGaps = gaps.slice().sort((a, b) => a.ts - b.ts);
    let idx = 0;
    let runSum = 0;
    let runCount = 0;
    const cumulative = months.map((m) => {
      const [y, mo] = m.key.split("-").map(Number);
      const monthEnd = new Date(y, mo, 1).getTime();
      while (idx < sortedGaps.length && sortedGaps[idx].ts < monthEnd) {
        runSum += sortedGaps[idx].hours;
        runCount += 1;
        idx += 1;
      }
      return { key: m.key, label: m.label, avg: runCount > 0 ? runSum / runCount : 0 };
    });

    return { months, cumulative };
  }

  // 棒グラフ（＋任意で折れ線を重ねる）のSVGを生成する。barsとlineは同じlabel列を想定
  function buildBarLineChart(bars, line, opts) {
    const width = Math.max(320, bars.length * 34 + 60);
    const height = 190;
    const padding = { top: 34, right: 14, bottom: 26, left: 34 };
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;

    if (bars.length === 0) {
      return { svg: "", width };
    }

    const allValues = bars.map((b) => b.avg).concat(line ? line.map((l) => l.avg) : []);
    const maxVal = Math.max(1, ...allValues) * 1.15;
    const n = bars.length;
    const band = innerW / n;
    const barW = Math.max(6, Math.min(28, band * 0.55));

    const xCenter = (i) => padding.left + band * i + band / 2;
    const yScale = (v) => padding.top + innerH - (v / maxVal) * innerH;
    const fmt = (v) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1));

    const barsSvg = bars.map((b, i) => {
      const barH = (b.avg / maxVal) * innerH;
      const x = xCenter(i) - barW / 2;
      const y = padding.top + innerH - barH;
      const labelY = Math.max(padding.top - 6, y - 6);
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, barH).toFixed(1)}" rx="3" class="chart-bar"><title>${b.label}: 平均${b.avg.toFixed(1)}時間</title></rect><text x="${xCenter(i).toFixed(1)}" y="${labelY.toFixed(1)}" class="chart-value-label" text-anchor="middle">${fmt(b.avg)}</text>`;
    }).join("");

    let lineSvg = "";
    if (line && line.length > 0) {
      const points = line.map((l, i) => `${xCenter(i).toFixed(1)},${yScale(l.avg).toFixed(1)}`).join(" ");
      const dots = line.map((l, i) => {
        const cy = yScale(l.avg);
        return `<circle cx="${xCenter(i).toFixed(1)}" cy="${cy.toFixed(1)}" r="3" class="chart-line-dot"><title>${l.label}: 累計平均${l.avg.toFixed(1)}時間</title></circle><text x="${xCenter(i).toFixed(1)}" y="${(cy + 14).toFixed(1)}" class="chart-value-label line">${fmt(l.avg)}</text>`;
      }).join("");
      lineSvg = `<polyline points="${points}" class="chart-line" fill="none" />${dots}`;
    }

    const gridLines = [0, 0.5, 1].map((f) => {
      const v = maxVal * f;
      const y = yScale(v);
      return `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" class="chart-grid" /><text x="${(padding.left - 6).toFixed(1)}" y="${y.toFixed(1)}" class="chart-axis-label" text-anchor="end" dominant-baseline="middle">${Math.round(v)}h</text>`;
    }).join("");

    const labelStep = Math.max(1, Math.ceil(n / 8));
    const xLabels = bars.map((b, i) => {
      if (i % labelStep !== 0 && i !== n - 1) return "";
      return `<text x="${xCenter(i).toFixed(1)}" y="${height - 8}" class="chart-axis-label" text-anchor="middle">${b.label}</text>`;
    }).join("");

    const svg = `<svg viewBox="0 0 ${width} ${height}" class="interval-chart" role="img" aria-label="${opts && opts.ariaLabel ? opts.ariaLabel : "推移グラフ"}">${gridLines}${barsSvg}${lineSvg}${xLabels}</svg>`;
    return { svg, width };
  }

  function renderStats() {
    const el = document.getElementById("view-stats");
    const now = new Date();
    const { settings } = state.data;

    const weekStart = getWeekStart(now, settings.weekStart);
    const weekEnd = getWeekEnd(now, settings.weekStart);
    const weekCount = recordsInRange(weekStart.getTime(), weekEnd.getTime()).length;
    const weekSavings = calcSavings(daysElapsedInWeek(now, settings.weekStart), weekCount, settings);

    const monthCount = recordsInMonth(now).length;
    const monthSavings = calcSavings(daysElapsedInMonth(now), monthCount, settings);

    const totalCount = state.data.records.length;
    const totalDays = daysElapsedSince(state.data.trackingStartDate, now);
    const totalSavings = calcSavings(totalDays, totalCount, settings);

    // 実際の出費（1本あたりの単価 × 本数）
    const pricePerCigForSpend = pricePerCigarette(settings);
    const weekSpend = Math.round(weekCount * pricePerCigForSpend);
    const monthSpend = Math.round(monthCount * pricePerCigForSpend);
    const totalSpend = Math.round(totalCount * pricePerCigForSpend);

    const [sy, sm, sd] = state.data.trackingStartDate.split("-").map(Number);
    const startLabel = `${sy}年${sm}月${sd}日`;

    // 今の週間目標を続けた場合の長期節約シミュレーション
    const pricePerCig = pricePerCigarette(settings);
    const targetDailyRate = settings.weeklyLimit / 7;
    const dailySavingsAtGoal = (settings.baselinePerDay - targetDailyRate) * pricePerCig;
    const projectionRows = PROJECTION_PERIODS.map((p) =>
      `<tr><td>${p.label}</td><td>${formatSavingsAmount(Math.round(dailySavingsAtGoal * p.days))}</td></tr>`
    ).join("");

    // 週の目標をさらに減らした場合の節約シミュレーション（「今の目標」の節約額に上乗せした合計を表示する）
    const reduction = state.reductionAmount;
    const extraDailySavings = (reduction / 7) * pricePerCig;
    const combinedDailySavings = dailySavingsAtGoal + extraDailySavings;
    const reducedTarget = Math.max(0, settings.weeklyLimit - reduction);
    const reductionRows = PROJECTION_PERIODS.map((p) =>
      `<tr><td>${p.label}</td><td>${formatSavingsAmount(Math.round(combinedDailySavings * p.days))}</td></tr>`
    ).join("");

    // 喫煙間隔の推移グラフ（日別・月別＋累計）
    const gaps = computeIntervalGaps();
    const dailyIntervalRows = averageIntervalByDay(gaps, 30);
    const { months: monthlyIntervalRows, cumulative: cumulativeIntervalRows } = monthlyAndCumulativeInterval(gaps);

    const dailyChart = buildBarLineChart(dailyIntervalRows, null, { ariaLabel: "日別の平均喫煙間隔" });
    const monthlyChart = buildBarLineChart(monthlyIntervalRows, cumulativeIntervalRows, { ariaLabel: "月別の平均喫煙間隔と累計推移" });

    const dailyChartHtml = dailyChart.svg
      ? `<div class="chart-scroll"><div style="width:${dailyChart.width}px">${dailyChart.svg}</div></div>`
      : `<p class="empty-note">2本以上記録された日がまだありません</p>`;

    const monthlyChartHtml = monthlyChart.svg
      ? `<div class="chart-scroll"><div style="width:${monthlyChart.width}px">${monthlyChart.svg}</div></div>
         <div class="chart-legend">
           <span><span class="legend-swatch" style="background:var(--accent-strong)"></span>その月の平均</span>
           <span><span class="legend-swatch" style="background:var(--warning)"></span>累計の平均（推移）</span>
         </div>`
      : `<p class="empty-note">2本以上記録された月がまだありません</p>`;

    el.innerHTML = `
      <div class="section-title">本数と節約金額</div>
      <div class="card">
        <table class="stats-table">
          <thead>
            <tr><th>期間</th><th>本数</th><th>実際の出費</th><th>節約金額</th></tr>
          </thead>
          <tbody>
            <tr><td>今週</td><td>${weekCount}本</td><td>¥${weekSpend.toLocaleString()}</td><td>${formatSavingsAmount(weekSavings.savedAmount)}</td></tr>
            <tr><td>今月</td><td>${monthCount}本</td><td>¥${monthSpend.toLocaleString()}</td><td>${formatSavingsAmount(monthSavings.savedAmount)}</td></tr>
            <tr><td>累計</td><td>${totalCount}本</td><td>¥${totalSpend.toLocaleString()}</td><td>${formatSavingsAmount(totalSavings.savedAmount)}</td></tr>
          </tbody>
        </table>
        <div class="stats-note">
          記録開始日: ${startLabel}〜（${totalDays}日間）／ 1本あたり¥${pricePerCigForSpend.toFixed(1)}換算／ 比較基準: 以前は1日${settings.baselinePerDay}本のペース
        </div>
      </div>

      <div class="section-title">今の目標（週${settings.weeklyLimit}本）を続けたら</div>
      <div class="card">
        <table class="stats-table">
          <thead><tr><th>期間</th><th>節約金額（概算）</th></tr></thead>
          <tbody>${projectionRows}</tbody>
        </table>
        <div class="stats-note">週${settings.weeklyLimit}本ペース（1日${targetDailyRate.toFixed(1)}本）と、以前の1日${settings.baselinePerDay}本を比較した概算です（1ヶ月=30日, 1年=365日換算）</div>
      </div>

      <div class="section-title">目標をさらに減らしたら</div>
      <div class="card">
        <div class="field-row">
          <div>
            <div class="field-label">週の目標を</div>
            <div class="field-desc">本減らしたら、節約金額はいくらになるか</div>
          </div>
          <input type="number" id="stats-reduction" min="0" max="99" value="${reduction}">
        </div>
        <table class="stats-table">
          <thead><tr><th>期間</th><th>節約金額（概算）</th></tr></thead>
          <tbody>${reductionRows}</tbody>
        </table>
        <div class="stats-note">週${settings.weeklyLimit}本 → 週${reducedTarget}本にした場合の節約金額です（「今の目標を続けたら」に、この削減分を上乗せした合計）</div>
      </div>

      <div class="section-title">喫煙間隔の推移（日別）</div>
      <div class="card">
        ${dailyChartHtml}
        <div class="stats-note">1本吸ってから次の1本までの平均時間です。直近${dailyIntervalRows.length}日分（2本以上記録された日のみ）</div>
      </div>

      <div class="section-title">喫煙間隔の推移（月別・累計）</div>
      <div class="card">
        ${monthlyChartHtml}
        <div class="stats-note">棒＝その月の平均間隔、線＝記録開始からその月末までの累計平均間隔です</div>
      </div>
    `;

    document.getElementById("stats-reduction").addEventListener("change", (e) => {
      let v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v) || v < 0) v = 0;
      if (v > 99) v = 99;
      e.target.value = v;
      state.reductionAmount = v;
      renderStats();
    });
  }

  // ---------------------------------------------------------
  // レンダリング: 設定
  // ---------------------------------------------------------
  function renderSettings() {
    const el = document.getElementById("view-settings");
    const s = state.data.settings;
    const todayKey = dateKey(new Date());
    const dowOptions = DOW_LABELS.map((label, i) => `<option value="${i}" ${s.weekStart === i ? "selected" : ""}>${label}曜日</option>`).join("");

    el.innerHTML = `
      <div class="section-title">上限・目安</div>
      <div class="card settings-form">
        <div class="field-row">
          <div>
            <div class="field-label">週間上限</div>
            <div class="field-desc">1週間で守りたい本数（下の時間帯別の目安と自動で連動します）</div>
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

      <div class="section-title">時間帯別の目安</div>
      <div class="card settings-form">
        <div class="field-row">
          <div>
            <div class="field-label">午前（0時〜12時）</div>
          </div>
          <input type="number" id="set-morningTarget" min="0" max="99" value="${s.morningTarget}">
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">午後（12時〜18時）</div>
          </div>
          <input type="number" id="set-afternoonTarget" min="0" max="99" value="${s.afternoonTarget}">
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">夜（18時〜24時）</div>
            <div class="field-desc">仕事終わり後など</div>
          </div>
          <input type="number" id="set-eveningTarget" min="0" max="99" value="${s.eveningTarget}">
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

      <div class="section-title">節約計算の基準</div>
      <div class="card settings-form">
        <div class="field-row">
          <div>
            <div class="field-label">1箱の本数</div>
            <div class="field-desc">タバコ1箱に入っている本数</div>
          </div>
          <input type="number" id="set-packSize" min="1" max="99" value="${s.packSize}">
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">1箱の価格</div>
            <div class="field-desc">円</div>
          </div>
          <input type="number" id="set-packPrice" min="0" max="9999" value="${s.packPrice}">
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">以前の1日の本数</div>
            <div class="field-desc">節約額の比較基準（例: 毎日1箱なら1箱の本数と同じ値に）</div>
          </div>
          <input type="number" id="set-baselinePerDay" min="0" max="99" value="${s.baselinePerDay}">
        </div>
        <div class="field-row">
          <div>
            <div class="field-label">記録開始日</div>
            <div class="field-desc">統計タブの「累計」の起点</div>
          </div>
          <input type="date" id="set-trackingStartDate" value="${state.data.trackingStartDate}" max="${todayKey}">
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
    bindNumber("set-weekdayTarget", "weekdayTarget", 0, 99);
    bindNumber("set-weekendTarget", "weekendTarget", 0, 99);
    bindNumber("set-packSize", "packSize", 1, 99);
    bindNumber("set-packPrice", "packPrice", 0, 9999);
    bindNumber("set-baselinePerDay", "baselinePerDay", 0, 99);

    // 週間上限を編集したら、時間帯別目安(午前+午後+夜)を1日あたりに割り直す
    document.getElementById("set-weeklyLimit").addEventListener("change", (e) => {
      let v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v) || v < 1) v = 1;
      if (v > 999) v = 999;
      state.data.settings.weeklyLimit = v;
      syncPeriodsFromWeekly();
      saveData();
      showToast("保存しました（時間帯別の目安も更新）");
      renderCurrentView();
    });

    // 時間帯別目安を編集したら、週間上限を(午前+午後+夜)×7に合わせる
    const periodFieldIds = { morningTarget: "set-morningTarget", afternoonTarget: "set-afternoonTarget", eveningTarget: "set-eveningTarget" };
    Object.entries(periodFieldIds).forEach(([key, id]) => {
      document.getElementById(id).addEventListener("change", (e) => {
        let v = parseInt(e.target.value, 10);
        if (!Number.isFinite(v) || v < 0) v = 0;
        if (v > 99) v = 99;
        state.data.settings[key] = v;
        syncWeeklyFromPeriods();
        saveData();
        showToast("保存しました（週間上限も更新）");
        renderCurrentView();
      });
    });

    document.getElementById("set-weekStart").addEventListener("change", (e) => {
      state.data.settings.weekStart = parseInt(e.target.value, 10);
      saveData();
      showToast("保存しました");
      renderCurrentView();
    });

    document.getElementById("set-trackingStartDate").addEventListener("change", (e) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) return; // 未入力・不正値は無視する
      state.data.trackingStartDate = e.target.value;
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
    else if (state.currentView === "stats") renderStats();
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
    document.getElementById("mindful-backdrop").addEventListener("click", closeMindfulCheck);

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
