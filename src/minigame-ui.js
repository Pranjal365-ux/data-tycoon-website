const storageKey = eventId => `data-tycoon-puzzle-${localStorage.getItem("data-tycoon-active-team") || "anonymous"}-${eventId}`;
const readState = (eventId, game) => {
  try { return JSON.parse(localStorage.getItem(storageKey(eventId))) || initialState(game); }
  catch { return initialState(game); }
};
const initialState = game => ({ guesses: [], values: Array(game.puzzle?.length || 0).fill("").map(() => Array(game.puzzle?.length || 0).fill("")), selected: [], solved: false, feedback: "" });
const persist = (eventId, state) => localStorage.setItem(storageKey(eventId), JSON.stringify(state));
const safe = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function wordleMarks(word, answer) {
  const marks = Array(5).fill("absent");
  const remaining = answer.split("");
  for (let i = 0; i < 5; i++) if (word[i] === answer[i]) { marks[i] = "correct"; remaining[i] = ""; }
  for (let i = 0; i < 5; i++) {
    if (marks[i] === "correct") continue;
    const at = remaining.indexOf(word[i]);
    if (at !== -1) { marks[i] = "present"; remaining[at] = ""; }
  }
  return marks;
}

function puzzleMarkup(game, state) {
  let content = "";
  if (game.type === "wordle") {
    const rows = Array.from({ length: 6 }, (_, rowIndex) => {
      const attempt = state.guesses[rowIndex];
      return `<div class="wordle-row">${Array.from({ length: 5 }, (_, i) => `<span class="wordle-tile ${attempt?.marks[i] || ""}">${attempt?.word[i] || ""}</span>`).join("")}</div>`;
    }).join("");
    content = `<div class="wordle-board" aria-label="Word puzzle, six attempts">${rows}</div><form class="puzzle-form" data-form="wordle"><label for="wordGuess">Your five-letter guess</label><div class="puzzle-entry"><input id="wordGuess" name="guess" maxlength="5" minlength="5" autocomplete="off" autocapitalize="characters" required ${state.solved || state.guesses.length >= 6 ? "disabled" : ""}><button ${state.solved || state.guesses.length >= 6 ? "disabled" : ""}>CHECK WORD</button></div></form>`;
  } else if (game.type === "word-search") {
    const chosen = state.selected.map(index => game.grid[Math.floor(index / game.grid.length)][index % game.grid.length]).join("");
    const cells = game.grid.flatMap(row => [...row]).map((letter, index) => `<button type="button" class="word-cell ${state.selected.includes(index) ? "chosen" : ""}" data-cell="${index}" aria-label="${letter}, cell ${index + 1}">${letter}</button>`).join("");
    content = `<p class="puzzle-target">FIND · <b>${game.word.length} LETTERS</b></p><div class="wordsearch-grid" style="--grid-size:${game.grid.length}">${cells}</div><p class="selected-word">SELECTED · <b id="selectedWord">${chosen || "—"}</b></p><div class="puzzle-actions"><button type="button" data-check="word-search" ${state.solved ? "disabled" : ""}>CHECK WORD</button><button class="ghost" type="button" data-reset-selection>START OVER</button></div>`;
  } else if (game.type === "sudoku") {
    const rows = game.puzzle.map((row, r) => `<div class="sudoku-row">${row.map((given, c) => `<input class="sudoku-cell ${c === 1 ? "box-right" : ""} ${r === 1 ? "box-bottom" : ""}" aria-label="Row ${r + 1}, column ${c + 1}" type="number" min="1" max="4" value="${given || safe(state.values[r]?.[c] || "")}" data-sudoku-cell="${r},${c}" ${given || state.solved ? "disabled" : ""}>`).join("")}</div>`).join("");
    content = `<div class="sudoku-board" aria-label="Four by four mini Sudoku">${rows}</div><div class="puzzle-actions"><button type="button" data-check="sudoku" ${state.solved ? "disabled" : ""}>CHECK GRID</button><button class="ghost" type="button" data-reset-grid ${state.solved ? "disabled" : ""}>CLEAR ENTRIES</button></div>`;
  } else if (game.type === "anagram") {
    content = `<div class="anagram-card"><small>LETTERS TO FILE</small><strong>${game.scrambled}</strong><span>${safe(game.hint)}</span></div><form class="puzzle-form" data-form="answer"><label for="puzzleAnswer">Your answer</label><div class="puzzle-entry"><input id="puzzleAnswer" name="answer" autocomplete="off" ${state.solved ? "disabled" : ""}><button ${state.solved ? "disabled" : ""}>SUBMIT</button></div></form>`;
  } else {
    content = `<div class="number-question">${safe(game.question)}</div><form class="puzzle-form" data-form="answer"><label for="puzzleAnswer">Your answer</label><div class="puzzle-entry"><input id="puzzleAnswer" name="answer" type="number" inputmode="numeric" ${state.solved ? "disabled" : ""}><button ${state.solved ? "disabled" : ""}>SUBMIT</button></div></form>`;
  }
  return `<section class="mini-game" aria-label="Interactive event puzzle"><div class="mini-game-head"><span class="article-label">PAUSE FOR A PUZZLE</span><span class="puzzle-status">${state.solved ? "SOLVED" : "OPTIONAL · TIMER KEEPS RUNNING"}</span></div><h3>${safe(game.title)}</h3><p class="mini-game-prompt">${safe(game.prompt)}</p>${content}<p class="puzzle-feedback" role="status">${safe(state.feedback || (state.solved ? "Correct. Nice work, analyst." : ""))}</p></section>`;
}

export function mountMiniGame(container, game, eventId) {
  const freshContainer = container.cloneNode(false);
  container.replaceWith(freshContainer);
  container = freshContainer;
  const state = readState(eventId, game);
  const paint = () => { container.innerHTML = puzzleMarkup(game, state); };
  const save = () => persist(eventId, state);
  paint();

  container.addEventListener("input", event => {
    if (event.target.matches("[data-sudoku-cell]")) {
      const [row, column] = event.target.dataset.sudokuCell.split(",").map(Number);
      state.values[row][column] = event.target.value;
      save();
    }
  });
  container.addEventListener("click", event => {
    const cell = event.target.closest("[data-cell]");
    if (cell && !state.solved) {
      const index = Number(cell.dataset.cell);
      state.selected = state.selected.includes(index) ? state.selected.filter(value => value !== index) : [...state.selected, index];
      const chosen = state.selected.map(value => game.grid[Math.floor(value / game.grid.length)][value % game.grid.length]).join("");
      cell.classList.toggle("chosen", state.selected.includes(index));
      container.querySelector("#selectedWord").textContent = chosen || "—";
      save();
    }
    if (event.target.closest("[data-check='word-search']")) {
      const answer = game.path.flatMap(([row, column]) => [row * game.grid.length + column]);
      state.solved = state.selected.length === answer.length && state.selected.every((value, index) => value === answer[index]);
      state.feedback = state.solved ? "Word found. The wire is clear." : "Not quite. Select the letters in order, then check again.";
      save(); paint();
    }
    if (event.target.closest("[data-reset-selection]")) { state.selected = []; state.feedback = ""; save(); paint(); }
    if (event.target.closest("[data-reset-grid]")) { state.values = game.puzzle.map(row => row.map(() => "")); state.feedback = ""; save(); paint(); }
  });
  container.addEventListener("submit", event => {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.form === "wordle") {
      const guess = String(new FormData(form).get("guess") || "").trim().toUpperCase();
      if (guess.length !== 5) { state.feedback = "Enter five letters to file a guess."; }
      else {
        state.guesses.push({ word: guess, marks: wordleMarks(guess, game.answer) });
        state.solved = guess === game.answer;
        state.feedback = state.solved ? "Correct. The market word is yours." : state.guesses.length >= 6 ? `The word was ${game.answer}.` : "Guess filed. Green is right, amber is elsewhere.";
      }
    } else {
      const answer = String(new FormData(form).get("answer") || "").trim().toUpperCase();
      state.solved = answer === String(game.answer).toUpperCase();
      state.feedback = state.solved ? "Correct. Filed for the record." : "Not quite. Recheck the clue and try again.";
    }
    save(); paint();
  });
  container.addEventListener("click", event => {
    if (!event.target.closest("[data-check='sudoku']")) return;
    state.values = game.puzzle.map((row, r) => row.map((given, c) => given || container.querySelector(`[data-sudoku-cell='${r},${c}']`)?.value || ""));
    state.solved = state.values.every((row, r) => row.every((value, c) => Number(value) === game.solution[r][c]));
    state.feedback = state.solved ? "Grid complete. A tidy set of numbers." : "The grid still has a mismatch. Check each row and column.";
    save(); paint();
  });
}
