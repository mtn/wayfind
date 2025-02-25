def add_numbers(a, b):
  total = a + b
  return total

def compute_fibonacci(n):
  if n <= 0:
      return []
  elif n == 1:
      return [0]
  fib_sequence = [0, 1]
  for i in range(2, n):
      next_val = fib_sequence[i - 1] + fib_sequence[i - 2]
      fib_sequence.append(next_val)
  return fib_sequence

def main():
    print("Starting test script for debugger step-through...")
    a, b = 3, 4
    print("Adding numbers:", a, "and", b)
    result = add_numbers(a, b)
    print("Result of add_numbers:", result)
    n = 10
    print("Computing Fibonacci sequence for first", n, "terms")
    fib_series = compute_fibonacci(n)
    print("Fibonacci sequence:", fib_series)
    raise AssertionError("test exception")
    print("Test script finished.")

if __name__ == '__main__':
  main()