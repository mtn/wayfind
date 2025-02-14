"use client";

import React, { useState, useEffect } from "react";

interface WatchExpression {
  id: number;
  expression: string;
  result?: string;
}

interface WatchExpressionsProps {
  // onEvaluate should take an expression and return a promise that resolves to its evaluated value
  onEvaluate: (expression: string) => Promise<string>;
  // isPaused is true when the debugger is stopped (so you want to update the watch values)
  isPaused: boolean;
}

export function WatchExpressions({
  onEvaluate,
  isPaused,
}: WatchExpressionsProps) {
  const [expressions, setExpressions] = useState<WatchExpression[]>([]);
  const [inputValue, setInputValue] = useState("");

  // When the debugger is paused, re‑evaluate all existing watch expressions.
  useEffect(() => {
    if (isPaused) {
      expressions.forEach(async (expr) => {
        try {
          const result = await onEvaluate(expr.expression);
          setExpressions((prev) =>
            prev.map((item) =>
              item.id === expr.id ? { ...item, result } : item,
            ),
          );
        } catch (e) {
          setExpressions((prev) =>
            prev.map((item) =>
              item.id === expr.id ? { ...item, result: "Error" } : item,
            ),
          );
        }
      });
    }
  }, [isPaused, expressions, onEvaluate]);

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
              {isPaused ? (expr.result ?? "Evaluating...") : "Not evaluated"}
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
}

export default WatchExpressions;
