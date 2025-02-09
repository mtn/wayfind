#!/usr/bin/env python3
"""
This script makes a series of HTTP POST requests against our Next.js /api/debug endpoints.
It mimics the equivalent DAP client sequence from the python debug test script:
  1. Launch the debug session.
  2. Issue an evaluation request for an expression (e.g. next_val).
  3. Send a continue request.

For a more complete test (e.g. breakpoints and stack traces) you’d extend/chain more calls,
but this minimal script demonstrates how to automate our API testing.
"""

import requests
import time

# Adjust this URL if your Next.js app is running on a different host/port.
BASE_URL = "http://localhost:3000/api/debug"

def launch_debug_session():
    url = f"{BASE_URL}?action=launch"
    print("Launching debug session using:", url)
    r = requests.post(url)
    try:
        response = r.json()
    except Exception as e:
        print("Error parsing launch response:", e)
        response = r.text
    print("Launch response:", response)
    if not r.ok or "error" in response:
        raise Exception("Launching debug session failed: " + str(response))
    return response

def evaluate_expression(expression, thread_id=1):
    url = f"{BASE_URL}?action=evaluate"
    payload = {"expression": expression, "threadId": thread_id}
    print("Evaluating expression with payload:", payload)
    r = requests.post(url, json=payload)
    try:
        response = r.json()
    except Exception as e:
        print("Error parsing evaluate response:", e)
        response = r.text
    print("Evaluate response:", response)
    if not r.ok or "error" in response:
        raise Exception("Evaluation failed: " + str(response))
    return response

def continue_execution(thread_id=1):
    url = f"{BASE_URL}?action=continue"
    payload = {"threadId": thread_id}
    print("Sending continue request with payload:", payload)
    r = requests.post(url, json=payload)
    try:
        response = r.json()
    except Exception as e:
        print("Error parsing continue response:", e)
        response = r.text
    print("Continue response:", response)
    if not r.ok or "error" in response:
        raise Exception("Continue failed: " + str(response))
    return response

def main():
    # 1. Launch debug session (which in our API spawns the debugpy process and sends initialize/attach commands)
    try:
        _ = launch_debug_session()
    except Exception as e:
        print("Error during launch:", e)
        return

    # Give the launched debugpy process some time to settle (you might need to adjust this delay)
    print("Waiting for debug session to settle...")
    time.sleep(3)

    # 2. Evaluate an expression. Our API endpoint does a stackTrace and evaluate.
    try:
        _ = evaluate_expression("next_val", thread_id=1)
    except Exception as e:
        print("Error during evaluation:", e)
        return

    # 3. Continue execution.
    try:
        _ = continue_execution(thread_id=1)
    except Exception as e:
        print("Error during continue:", e)
        return

    print("All API requests completed successfully.")

if __name__ == "__main__":
    main()