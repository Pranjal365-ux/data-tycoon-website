// One short puzzle per live flash event.
const sudokuSolution = [
  [1, 2, 3, 4],
  [3, 4, 1, 2],
  [2, 1, 4, 3],
  [4, 3, 2, 1]
];

export const miniGamesByEvent = {
  "flash-1": {
    type: "wordle", title: "THE MINERAL DESK", prompt: "Guess the five-letter word connected to the miracle material discovery.", answer: "LIGHT"
  },
  "flash-2": {
    type: "word-search", title: "THE PORT MANIFEST", prompt: "Find the five-letter word hidden across the top row.",
    grid: ["CARGOPQ", "LTXNEMA", "BWRIFDS", "YHOKVLU", "SEAPORT", "NQWCEIA", "FJRMXTB"],
    word: "CARGO", path: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]
  },
  "flash-3": {
    type: "anagram", title: "THE RECOVERY DESK", prompt: "Rearrange the letters to name what was lost in the unrefrigerated warehouse.", scrambled: "OLISPED", answer: "SPOILED", hint: "What happened to the food and pharma shipments."
  },
  "flash-4": {
    type: "sudoku", title: "THE TIME GRID", prompt: "Complete each row, column, and 2×2 box with 1–4.",
    puzzle: [[1, 0, 0, 4], [0, 4, 1, 0], [0, 1, 4, 0], [4, 0, 0, 1]], solution: sudokuSolution
  }
};
