// Contract probe for allocation previews: match RoomLayoutGenerator's fixed-first
// largest-remainder allocation, while keeping instruction identifiers internal.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "board-room-admin.js"), "utf8");
const begin = source.indexOf("  function calculateAllocationEstimate(definitions, cellCount) {");
const end = source.indexOf("  function selectedBoardCellCount() {", begin);
if (begin < 0 || end < 0) throw new Error("allocation preview helper missing");
const calculate = vm.runInNewContext(
  source.slice(begin, end) + "\ncalculateAllocationEstimate;",
  { Math, Number, Array }
);
function assert(value, message) { if (!value) throw new Error(message); }
const fixed = value => ({ enabled: true, mode: "count", value });
const ratio = value => ({ enabled: true, mode: "ratio", value });
const base = [ratio(10), ratio(10), fixed(1), fixed(1), fixed(1)];

const small = calculate(base, 24);
assert(small.assignable === 23 && small.fixedTotal === 3 && small.ratioBase === 20,
  "8×6 excludes START and three fixed effect cells");
assert(JSON.stringify([...small.counts]) === "[2,2,1,1,1]",
  "8×6 should place two of each 10-percent effect");

const normal = calculate(base, 36);
assert(normal.ratioBase === 32 && JSON.stringify([...normal.counts]) === "[3,3,1,1,1]",
  "12×8 should allocate three of each 10-percent effect");

const large = calculate(base, 52);
assert(large.ratioBase === 48 && JSON.stringify([...large.counts]) === "[5,5,1,1,1]",
  "16×12 should allocate five of each 10-percent effect");

const ties = calculate([ratio(10), ratio(10), ratio(10)], 25);
assert(JSON.stringify([...ties.counts]) === "[3,2,2]",
  "equal fractional remainders must be distributed in source order");
const inactive = calculate([ratio(10), { ...fixed(5), enabled: false }], 24);
assert(inactive.fixedTotal === 0 && inactive.ratioBase === 23,
  "disabled fixed effects must not consume allocatable cells");
assert(calculate([fixed(25)], 24).error, "count overflow must warn instead of suggesting invalid slots");
assert(calculate([ratio(60), ratio(60)], 24).error, "ratio overflow must warn instead of suggesting invalid slots");
assert(calculate(base, NaN).error, "invalid board dimensions must not produce fake allocations");
assert(source.includes('<input type="hidden" data-field="instructionId"'),
  "internal instruction IDs must remain in DOM for API/presets");
assert(!source.includes('<label>ID'), "internal instruction IDs must not appear in editor labels");
assert(!source.includes('select.append(label, id)'), "internal IDs must not appear in instruction list");
assert(source.includes("{n}은 이 칸에 도착했을 때 움직이는 칸 수"),
  "{n} must explain movement distance");
assert(source.includes("{m}은 다음 던지기의 이동 칸 수에 곱할 배수"),
  "{m} must explain multiplication");
console.log("Board instruction allocation and placeholder guidance probe passed.");
