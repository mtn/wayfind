fn main() {
    println!("Starting simple Rust program");

    let mut counter = 0;
    while counter < 10 {
        println!("Counter: {}", counter);
        counter += 1;
    }

    let result = calculate_sum(5, 7);
    println!("Result: {}", result);

    println!("Program completed");
}

fn calculate_sum(a: i32, b: i32) -> i32 {
    let sum = a + b;
    println!("Calculated sum of {} and {}: {}", a, b, sum);
    sum
}
