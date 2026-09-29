(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

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
    return cryptoShuffle(
      Array.from({ length: maxNumber }, (_, index) => index + 1)
    )
      .slice(0, count)
      .sort((a, b) => a - b);
  }

  function render(numbers) {
    const root = $("numberResult");
    root.replaceChildren();
    if (!numbers.length) {
      const empty = document.createElement("div");
      empty.className = "quick-empty";
      empty.textContent = "추첨을 시작하세요.";
      root.appendChild(empty);
      return;
    }
    for (const number of numbers) {
      const ball = document.createElement("div");
      ball.className = "number-ball";
      ball.textContent = String(number);
      root.appendChild(ball);
    }
  }

  function runDraw() {
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
    render(numbers);
    $("status").textContent =
      "브라우저에서 추첨 완료 · " + numbers.join(", ");
  }

  async function copyResult() {
    const text = [...document.querySelectorAll(".number-ball")]
      .map((element) => element.textContent)
      .join(", ");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      $("status").textContent = "결과를 복사했습니다.";
    } catch {
      $("status").textContent = "결과 복사에 실패했습니다.";
    }
  }

  $("runDraw").addEventListener("click", runDraw);
  $("copyResult").addEventListener("click", copyResult);
  render([]);
})();
