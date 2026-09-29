(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const mode = document.body.dataset.drawMode;

  function randomInt(maxExclusive) {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("invalid random range");
    }
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buffer = new Uint32Array(1);
    let value;
    do {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    } while (value >= limit);
    return value % maxExclusive;
  }

  function cryptoShuffle(values) {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function drawUniqueNumbers(maxNumber, count) {
    const values = Array.from(
      { length: maxNumber },
      (_, index) => index + 1
    );
    return cryptoShuffle(values)
      .slice(0, count)
      .sort((a, b) => a - b);
  }

  function parseEntries(raw) {
    const seen = new Set();
    const entries = [];
    for (const line of String(raw || "").split(/\r?\n/)) {
      const value = line.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      entries.push(value);
    }
    return entries;
  }

  function renderNumberResult(numbers) {
    const root = $("numberResult");
    root.replaceChildren();
    for (const number of numbers) {
      const ball = document.createElement("div");
      ball.className = "number-ball";
      ball.textContent = String(number);
      root.appendChild(ball);
    }
  }

  function runNumberDraw() {
    const max = Math.max(
      1,
      Math.min(999, Math.trunc(Number($("maxNumber").value) || 45))
    );
    const count = Math.max(
      1,
      Math.min(7, Math.trunc(Number($("drawCount").value) || 1))
    );
    if (count > max) {
      $("status").textContent = "추첨 개수는 최대 번호보다 클 수 없습니다.";
      return;
    }
    $("maxNumber").value = String(max);
    $("drawCount").value = String(count);
    const numbers = drawUniqueNumbers(max, count);
    renderNumberResult(numbers);
    $("status").textContent =
      "브라우저에서 추첨 완료 · "
      + numbers.join(", ");
  }

  function renderViewerResult(winners) {
    const root = $("viewerResult");
    root.replaceChildren();
    winners.forEach((name, index) => {
      const row = document.createElement("div");
      row.className = "viewer-winner";
      const rank = document.createElement("span");
      rank.textContent = "#" + (index + 1);
      const label = document.createElement("strong");
      label.textContent = name;
      row.append(rank, label);
      root.appendChild(row);
    });
  }

  function runViewerDraw() {
    const entries = parseEntries($("entries").value);
    const count = Math.max(
      1,
      Math.min(
        100,
        Math.trunc(Number($("winnerCount").value) || 1)
      )
    );
    if (!entries.length) {
      $("status").textContent = "참가자를 한 명 이상 입력하세요.";
      return;
    }
    if (count > entries.length) {
      $("status").textContent =
        "당첨자 수가 참가자 수보다 많습니다.";
      return;
    }
    $("winnerCount").value = String(count);
    const winners = cryptoShuffle(entries).slice(0, count);
    renderViewerResult(winners);
    $("status").textContent =
      "브라우저에서 추첨 완료 · 참가자 "
      + entries.length
      + "명";
  }

  async function copyResult() {
    let text = "";
    if (mode === "NUMBER") {
      text = [...document.querySelectorAll(".number-ball")]
        .map((element) => element.textContent)
        .join(", ");
    } else {
      text = [...document.querySelectorAll(".viewer-winner strong")]
        .map((element, index) => "#" + (index + 1) + " " + element.textContent)
        .join("\n");
    }
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      $("status").textContent = "결과를 복사했습니다.";
    } catch {
      $("status").textContent = "결과 복사에 실패했습니다.";
    }
  }

  $("runDraw").addEventListener(
    "click",
    mode === "NUMBER" ? runNumberDraw : runViewerDraw
  );
  $("copyResult").addEventListener("click", copyResult);

  if (mode === "NUMBER") {
    renderNumberResult([]);
  } else {
    renderViewerResult([]);
  }
})();
