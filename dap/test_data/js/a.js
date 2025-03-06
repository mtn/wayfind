function addNumbers(a, b) {
  const total = a + b;
  return total;
}

function computeFibonacci(n) {
  if (n <= 0) {
    return [];
  } else if (n == 1) {
    return [0];
  }
  let fibSequence = [0, 1];
  for (let i = 2; i < n; i++) {
    const nextVal = fibSequence[i - 1] + fibSequence[i - 2];
    fibSequence.push(nextVal);
  }
  return fibSequence;
}

function main() {
  console.log("Starting test script for debugger step-through...");
  const a = 3,
    b = 4;
  console.log("Adding numbers:", a, "and", b);
  const result = addNumbers(a, b);
  console.log("Result of addNumbers:", result);
  const n = 10;
  console.log("Computing Fibonacci sequence for first", n, "terms");
  const fibSeries = computeFibonacci(n);
  console.log("Fibonacci sequence:", fibSeries);
  console.log("Test script finished.");
}

main();
