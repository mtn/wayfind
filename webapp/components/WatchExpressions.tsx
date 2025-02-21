"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useRef,
} from "react";

interface WatchExpression {
  id: number;
  expression: string;
  result?: string;
}

export interface WatchExpressionsProps {
  // onEvaluate should take an expression and return a promise that resolves to its evaluated value
  onEvaluate: (expression: string) => Promise<string>;
  // isPaused is true when the debugger is stopped (so you want to update the watch values)
  isPaused: boolean;
}

export interface WatchExpressionsHandle {
  reevaluate: () => void;
}

const WatchExpressions = forwardRef<
  WatchExpressionsHandle,
  WatchExpressionsProps
>(({ onEvaluate, isPaused }, ref) => {
  const [expressions, setExpressions] = useState<WatchExpression[]>([]);
  const [inputValue, setInputValue] = useState("");

  // Optional logging for isPaused changes.
  useEffect(() => {
    console.log("isPaused changed:", isPaused);
  }, [isPaused]);

  // Wrap evaluateAll in useCallback so it doesn't change on every render.
  const evaluateAll = useCallback(() => {
    if (isPaused) {
      // Use functional updates to get the latest expressions
      setExpressions((prevExpressions) => {
        // For each expression in the current state,
        // call onEvaluate and eventually update it if needed.
        prevExpressions.forEach(async (expr) => {
          try {
            const result = await onEvaluate(expr.expression);
            setExpressions((current) =>
              current.map((item) =>
                item.id === expr.id ? { ...item, result } : item,
              ),
            );
          } catch (error) {
            setExpressions((current) =>
              current.map((item) =>
                item.id === expr.id ? { ...item, result: "Error" } : item,
              ),
            );
          }
        });
        return prevExpressions;
      });
    }
  }, [isPaused, onEvaluate]);

  // When the number of expressions changes, re-evaluate all expressions.
  const prevExpressionCountRef = useRef(expressions.length);
  useEffect(() => {
    console.log(expressions.length, isPaused, evaluateAll);
    if (isPaused) {
      evaluateAll();
    }
    prevExpressionCountRef.current = expressions.length;
  }, [expressions.length, isPaused, evaluateAll]);

  // Expose the reevaluate method to the parent.
  useImperativeHandle(
    ref,
    () => ({
      reevaluate() {
        evaluateAll();
      },
    }),
    [evaluateAll],
  );

  // Handler for adding a new expression.
  const handleAddExpression = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    const newExpr: WatchExpression = { id: Date.now(), expression: trimmed };
    setExpressions((prev) => [...prev, newExpr]);
    setInputValue("");
  };

  const handleRemoveExpression = (id: number) => {
    setExpressions((prev) => prev.filter((expr) => expr.id !== id));
  };

  return (
    <div className="p-2 border-t">
      <h2 className="font-bold mb-2">Watch Expressions</h2>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Enter a watch expression"
          className="border p-1 flex-1 rounded"
        />
        <button
          onClick={handleAddExpression}
          className="px-2 py-1 bg-blue-500 text-white rounded"
        >
          Add
        </button>
      </div>
      <ul>
        {expressions.map((expr) => (
          <li key={expr.id} className="mb-1 flex justify-between items-center">
            <span>
              <strong>{expr.expression}</strong>:{" "}
              {expr.result !== undefined
                ? expr.result
                : isPaused
                  ? "Evaluating..."
                  : "Not evaluated"}
            </span>
            <button
              onClick={() => handleRemoveExpression(expr.id)}
              className="text-red-500"
            >
              x
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});

WatchExpressions.displayName = "WatchExpressions";

export default WatchExpressions;
