/**
 * Procedural item families with exact, machine-checkable answers.
 *
 * Every family is a pure function of the PRNG, so a bank is fully determined by
 * (master seed, benchmark id). Answers are returned already in canonical form
 * (see canonical.ts); prompts never leave the author's machine in plaintext.
 */
import { Prng } from "./prng.js";
import { normalize } from "./canonical.js";

export interface Item {
  family: string;
  prompt: string;
  answer: string;
}

export type Family = (rng: Prng, difficulty: number) => Item;

const WORDS = (
  "amber basil cedar delta ember fable gable hazel iris jade kayak lemon mango nadir olive " +
  "pearl quartz raven sable tulip umber violet walnut xenon yarrow zephyr anvil bramble " +
  "cinder dusk falcon glacier harbor ivory juniper kestrel lantern meadow nectar orchid " +
  "pepper quill ripple saffron thistle upland velvet willow yonder zinc"
).split(" ");

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// ------------------------------------------------------------------ families

export const arithChain: Family = (rng, d) => {
  const steps = 5 + 3 * d + rng.int(0, 2);
  let v = BigInt(rng.int(2, 99));
  const lines = [`Start with ${v}.`];
  for (let i = 0; i < steps; i++) {
    const op = rng.pick(["add", "sub", "mul", "mod", "add", "mul"] as const);
    if (op === "add") {
      const k = rng.int(3, 97);
      v += BigInt(k);
      lines.push(`Add ${k}.`);
    } else if (op === "sub") {
      const k = rng.int(3, 97);
      v -= BigInt(k);
      lines.push(`Subtract ${k}.`);
    } else if (op === "mul") {
      const k = rng.int(2, 13);
      v *= BigInt(k);
      lines.push(`Multiply by ${k}.`);
    } else {
      const k = rng.int(7, 199);
      v = ((v % BigInt(k)) + BigInt(k)) % BigInt(k);
      lines.push(`Take the remainder when divided by ${k} (result in 0..${k - 1}).`);
    }
  }
  lines.push("What is the final value?");
  return { family: "arith_chain", prompt: lines.join(" "), answer: normalize(v.toString()) };
};

export const stackMachine: Family = (rng, d) => {
  const n = 8 + 4 * d + rng.int(0, 3);
  const stack: bigint[] = [];
  const ops: string[] = [];
  for (let i = 0; i < n; i++) {
    const depth = stack.length;
    const choices: string[] = ["PUSH"];
    if (depth >= 1) choices.push("DUP", "NEG", "INC");
    if (depth >= 2) choices.push("ADD", "SUB", "MUL", "SWAP", "ADD", "MUL");
    if (depth >= 3) choices.push("POP");
    const op = rng.pick(choices);
    switch (op) {
      case "PUSH": {
        const k = rng.int(-9, 19);
        stack.push(BigInt(k));
        ops.push(`PUSH ${k}`);
        break;
      }
      case "DUP":
        stack.push(stack[stack.length - 1]);
        ops.push("DUP");
        break;
      case "NEG":
        stack[stack.length - 1] = -stack[stack.length - 1];
        ops.push("NEG");
        break;
      case "INC":
        stack[stack.length - 1] += 1n;
        ops.push("INC");
        break;
      case "ADD": {
        const b = stack.pop()!, a = stack.pop()!;
        stack.push(a + b);
        ops.push("ADD");
        break;
      }
      case "SUB": {
        const b = stack.pop()!, a = stack.pop()!;
        stack.push(a - b);
        ops.push("SUB");
        break;
      }
      case "MUL": {
        const b = stack.pop()!, a = stack.pop()!;
        stack.push(a * b);
        ops.push("MUL");
        break;
      }
      case "SWAP": {
        const b = stack.pop()!, a = stack.pop()!;
        stack.push(b, a);
        ops.push("SWAP");
        break;
      }
      case "POP":
        stack.pop();
        ops.push("POP");
        break;
    }
  }
  const prompt =
    "A stack machine starts with an empty stack and executes these instructions in order. " +
    "PUSH n pushes n. DUP duplicates the top. NEG negates the top. INC adds 1 to the top. " +
    "ADD, SUB, MUL pop b (top) then a and push a+b, a-b, a*b respectively. SWAP swaps the top two. " +
    "POP discards the top. Program: " +
    ops.join("; ") +
    ". What integer is on top of the stack when the program ends?";
  return { family: "stack_machine", prompt, answer: normalize(stack[stack.length - 1].toString()) };
};

export const listOps: Family = (rng, d) => {
  const len = 6 + 2 * d;
  let xs = Array.from({ length: len }, () => rng.int(1, 60));
  const lines = [`Start with the list [${xs.join(", ")}].`];
  const steps = 3 + d + rng.int(0, 1);
  for (let i = 0; i < steps; i++) {
    const op = rng.pick(["reverse", "rotate", "sort_desc", "drop_even_pos", "add_index", "sort_asc"] as const);
    if (op === "reverse") {
      xs = xs.slice().reverse();
      lines.push("Reverse the list.");
    } else if (op === "rotate") {
      const k = rng.int(1, xs.length - 1);
      xs = xs.slice(k).concat(xs.slice(0, k));
      lines.push(`Rotate the list left by ${k} positions (the first ${k} elements move to the end).`);
    } else if (op === "sort_desc") {
      xs = xs.slice().sort((a, b) => b - a);
      lines.push("Sort the list in descending order.");
    } else if (op === "sort_asc") {
      xs = xs.slice().sort((a, b) => a - b);
      lines.push("Sort the list in ascending order.");
    } else if (op === "drop_even_pos") {
      if (xs.length > 3) {
        xs = xs.filter((_, i) => i % 2 === 0);
        lines.push("Keep only the elements at even 0-based positions (positions 0, 2, 4, ...).");
      }
    } else {
      xs = xs.map((x, i) => x + i);
      lines.push("Add each element's 0-based position to it.");
    }
  }
  const q = rng.pick(["sum", "index", "max_minus_min"] as const);
  let answer: number;
  if (q === "sum") {
    answer = xs.reduce((a, b) => a + b, 0);
    lines.push("What is the sum of the resulting list?");
  } else if (q === "index") {
    const k = rng.int(0, xs.length - 1);
    answer = xs[k];
    lines.push(`What is the element at 0-based index ${k} of the resulting list?`);
  } else {
    answer = Math.max(...xs) - Math.min(...xs);
    lines.push("What is the maximum minus the minimum of the resulting list?");
  }
  return { family: "list_ops", prompt: lines.join(" "), answer: normalize(String(answer)) };
};

export const caesar: Family = (rng, d) => {
  const nWords = 1 + Math.min(d, 2);
  const words = Array.from({ length: nWords }, () => rng.pick(WORDS));
  const shift = rng.int(1, 25);
  const reverse = d >= 2 && rng.int(0, 1) === 1;
  const enc = (w: string) =>
    w
      .split("")
      .map((c) => String.fromCharCode(((c.charCodeAt(0) - 97 + shift) % 26) + 97))
      .join("");
  let out = words.map(enc);
  if (reverse) out = out.map((w) => w.split("").reverse().join(""));
  const prompt =
    `Apply a Caesar shift of +${shift} to each letter of the phrase "${words.join(" ")}" ` +
    `(a->${String.fromCharCode(97 + shift)}, wrapping z back to a)` +
    (reverse ? ", then reverse the letters of each word" : "") +
    ". Give the resulting phrase in lowercase, words separated by single spaces.";
  return { family: "caesar", prompt, answer: normalize(out.join(" ")) };
};

export const baseConvert: Family = (rng, d) => {
  const n = rng.int(100, d >= 2 ? 200_000 : 5_000);
  const base = rng.pick(d >= 2 ? [2, 3, 5, 7, 8, 12, 16, 20] : [2, 8, 16]);
  const digits = "0123456789abcdefghijklmnopqrstuvwxyz";
  let x = n, s = "";
  while (x > 0) {
    s = digits[x % base] + s;
    x = Math.floor(x / base);
  }
  const prompt =
    `Write the decimal number ${n} in base ${base}. Use the digits 0-9 and then lowercase letters a, b, c, ... ` +
    `for digit values 10, 11, 12, ... Give only the base-${base} representation without any prefix.`;
  return { family: "base_convert", prompt, answer: normalize(s) };
};

export const gridWalk: Family = (rng, d) => {
  const n = 6 + 3 * d + rng.int(0, 2);
  let x = 0, y = 0, dir = 0; // 0 N, 1 E, 2 S, 3 W
  const dx = [0, 1, 0, -1], dy = [1, 0, -1, 0];
  const cmds: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = rng.pick(["F", "F", "L", "R", "B"] as const);
    if (c === "F" || c === "B") {
      const k = rng.int(1, 9);
      const sgn = c === "F" ? 1 : -1;
      x += sgn * k * dx[dir];
      y += sgn * k * dy[dir];
      cmds.push(`${c}${k}`);
    } else {
      dir = (dir + (c === "R" ? 1 : 3)) % 4;
      cmds.push(c);
    }
  }
  const prompt =
    "A robot starts at (0, 0) facing north (positive y). Commands: Fk moves forward k units, Bk moves backward k units, " +
    "L turns left 90 degrees, R turns right 90 degrees. East is positive x. Execute: " +
    cmds.join(" ") +
    ". Give the final position as x,y (two integers separated by a comma).";
  return { family: "grid_walk", prompt, answer: normalize(`${x},${y}`) };
};

export const gcdLcm: Family = (rng, d) => {
  const g = rng.int(2, 60);
  const a = g * rng.int(7, d >= 2 ? 400 : 60);
  const b = g * rng.int(7, d >= 2 ? 400 : 60);
  const gcd = (p: number, q: number): number => (q === 0 ? p : gcd(q, p % q));
  const gg = gcd(a, b);
  const which = rng.pick(["gcd", "lcm"] as const);
  const ans = which === "gcd" ? gg : (a / gg) * b;
  const prompt = `What is the ${which === "gcd" ? "greatest common divisor" : "least common multiple"} of ${a} and ${b}?`;
  return { family: "gcd_lcm", prompt, answer: normalize(String(ans)) };
};

export const digitSum: Family = (rng, d) => {
  const a = BigInt(rng.int(100, d >= 2 ? 99_999 : 999));
  const b = BigInt(rng.int(100, d >= 2 ? 99_999 : 999));
  const p = a * b;
  const sum = p.toString().split("").reduce((s, c) => s + Number(c), 0);
  const prompt = `Compute ${a} × ${b}. What is the sum of the decimal digits of the result?`;
  return { family: "digit_sum", prompt, answer: normalize(String(sum)) };
};

export const weekday: Family = (rng, d) => {
  const start = rng.int(0, 6);
  const n = rng.int(10, d >= 2 ? 100_000 : 1_000);
  const back = rng.int(0, 1) === 1;
  const idx = (((start + (back ? -n : n)) % 7) + 7) % 7;
  const prompt = `If today is ${DAYS[start]}, what day of the week is it ${n} days ${back ? "earlier" : "later"}? Give the day name.`;
  return { family: "weekday", prompt, answer: normalize(DAYS[idx]) };
};

export const wordSort: Family = (rng, d) => {
  const n = 5 + 2 * d;
  const ws = rng.shuffle(WORDS.slice()).slice(0, n);
  const sorted = ws.slice().sort();
  const desc = rng.int(0, 1) === 1;
  const order = desc ? sorted.slice().reverse() : sorted;
  const k = rng.int(0, n - 1);
  const prompt =
    `Sort these words ${desc ? "in reverse alphabetical (z to a)" : "alphabetically (a to z)"} order: ` +
    ws.join(", ") +
    `. Which word is at 1-based position ${k + 1} in the sorted list?`;
  return { family: "word_sort", prompt, answer: normalize(order[k]) };
};

export const FAMILIES: Record<string, Family> = {
  arith_chain: arithChain,
  stack_machine: stackMachine,
  list_ops: listOps,
  caesar,
  base_convert: baseConvert,
  grid_walk: gridWalk,
  gcd_lcm: gcdLcm,
  digit_sum: digitSum,
  weekday,
  word_sort: wordSort,
};
