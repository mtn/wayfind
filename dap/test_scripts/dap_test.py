#!/usr/bin/env python3
"""
A minimal DAP client that:
  – launches the target script (a.py) with debugpy;
  – connects to debugpy over TCP;
  – sends the initialize, setBreakpoints, and configurationDone requests;
  – waits for a breakpoint hit (stopped event),
  – sends an evaluate request to inspect variable "next_val" at the breakpoint,
  – sends a continue command then exits.
Note: This is a bare‐bones implementation meant for testing.
"""

import os
import sys
import json
import socket
import subprocess
import threading
import time
import re

# Global variables to help manage DAP messages
next_seq = 1
responses = {}
events = []

def next_sequence():
    global next_seq
    seq = next_seq
    next_seq += 1
    return seq

def send_dap_message(sock, message):
    """Send message as per DAP header format."""
    data = json.dumps(message)
    header = f"Content-Length: {len(data)}\r\n\r\n"
    sock.sendall(header.encode('utf-8') + data.encode('utf-8'))
    # For debugging:
    print(f"--> Sent (seq {message.get('seq')}, cmd: {message.get('command')}): {data}")
    print()

def read_dap_message(sock):
    """Read a DAP message from the socket. Blocks until complete."""
    # First, read header lines until an empty line is found.
    header = b""
    while b"\r\n\r\n" not in header:
        chunk = sock.recv(1)
        if not chunk:
            raise ConnectionError("Socket closed while reading header")
        header += chunk
    header_text, _ = header.split(b"\r\n\r\n", 1)
    # Parse content-length value:
    m = re.search(rb"Content-Length:\s*(\d+)", header_text)
    if not m:
        raise ValueError("Content-Length header not found")
    length = int(m.group(1))
    # Now read exactly 'length' bytes
    body = b""
    while len(body) < length:
        body += sock.recv(length - len(body))
    message = json.loads(body.decode('utf-8'))
    # For debugging:
    print(f"<-- Received: {json.dumps(message)}")
    print()
    return message

def dap_receiver(sock):
    """Thread function that continuously reads and processes DAP messages."""
    while True:
        try:
            msg = read_dap_message(sock)
        except Exception as e:
            print(f"Receiver exiting: {e}")
            break

        msg_type = msg.get("type")
        if msg_type == "response":
            req_seq = msg.get("request_seq")
            responses[req_seq] = msg
        elif msg_type == "event":
            events.append(msg)
        else:
            print("Unknown message type", msg)

def wait_for_event(event_name, timeout=10):
    """Wait for an event with a given name."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        for ev in events:
            if ev.get("event") == event_name:
                events.remove(ev)
                return ev
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event {event_name}")

def wait_for_response(seq, timeout=10):
    """Busy-wait for a response message with the given sequence number."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if seq in responses:
            resp = responses.pop(seq)
            return resp
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

def main():
    # Paths: adjust these as needed.
    target_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "test_data", "a.py"))
    debugpy_port = 5678

    # Step 1: Launch target script (a.py) with debugpy.
    # We must use --wait-for-client so that a.py does not run until we attach.
    launcher_cmd = [sys.executable, "-m", "debugpy", "--listen", f"127.0.0.1:{debugpy_port}",
                    "--wait-for-client", target_script]
    print("Launching target script with debugpy:", " ".join(launcher_cmd))
    proc = subprocess.Popen(launcher_cmd)
    # Give it a moment to start and open the port.
    time.sleep(1)

    # Step 2: Connect to debugpy over TCP.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", debugpy_port))
    print("Connected to debugpy.")

    # Start the DAP receiver thread.
    recv_thread = threading.Thread(target=dap_receiver, args=(sock,), daemon=True)
    recv_thread.start()

    # Step 3: Send "initialize" request.
    init_seq = next_sequence()
    init_req = {
        "seq": init_seq,
        "type": "request",
        "command": "initialize",
        "arguments": {
            "adapterID": "python",
            "clientID": "dap_test_client",
            "clientName": "DAP Test",
            "linesStartAt1": True,
            "columnsStartAt1": True,
            "pathFormat": "path",
            "supportsVariableType": True,
            "supportsEvaluateForHovers": True
        }
    }
    send_dap_message(sock, init_req)
    init_resp = wait_for_response(init_seq)
    # Typically, the adapter also sends an "initialized" event.
    _ = wait_for_event("initialized")
    print("Initialization complete.")

    # Step 4: Set a breakpoint in a.py.
    # Suppose we want to set a breakpoint at line 20 (in our a.py, the debug point).
    bp_seq = next_sequence()
    set_bp_req = {
        "seq": bp_seq,
        "type": "request",
        "command": "setBreakpoints",
        "arguments": {
            # Specify the source path that debugpy can see.
            "source": {
                "path": target_script,
                "name": os.path.basename(target_script)
            },
            "breakpoints": [
                {"line": 20}  # adjust if needed
            ],
            "sourceModified": False
        }
    }
    send_dap_message(sock, set_bp_req)
    bp_resp = wait_for_response(bp_seq)
    print("Breakpoints response:", bp_resp)

    # Step 5: Send configurationDone to tell the adapter that configuration is complete.
    conf_seq = next_sequence()
    conf_req = {
        "seq": conf_seq,
        "type": "request",
        "command": "configurationDone",
        "arguments": {}
    }
    send_dap_message(sock, conf_req)
    _ = wait_for_response(conf_seq)
    print("Sent configurationDone.")

    # Now the target (a.py) will resume until it hits the breakpoint.
    print("Waiting for the target to hit the breakpoint (stopped event)...")
    stopped_event = wait_for_event("stopped", timeout=15)
    print("Received stopped event:", stopped_event)

    # Step 6: While stopped at the breakpoint, send an evaluate request.
    eval_seq = next_sequence()
    eval_req = {
        "seq": eval_seq,
        "type": "request",
        "command": "evaluate",
        "arguments": {
            "expression": "next_val",
            "context": "hover",
            # Optionally, you can supply the frameId if you got one from a stackTrace response.
        }
    }
    send_dap_message(sock, eval_req)
    eval_resp = wait_for_response(eval_seq)
    print("Evaluate response:", eval_resp)
    # For example, you could extract the result:
    result_value = eval_resp.get("body", {}).get("result")
    print("Value of next_val at breakpoint:", result_value)

    # Step 7: Send a "continue" request so that the target can finish.
    cont_seq = next_sequence()
    cont_req = {
        "seq": cont_seq,
        "type": "request",
        "command": "continue",
        "arguments": {
            "threadId": stopped_event.get("body", {}).get("threadId", 1)
        }
    }
    send_dap_message(sock, cont_req)
    cont_resp = wait_for_response(cont_seq)
    print("Continue response:", cont_resp)

    # Give the target time to finish.
    proc.wait(timeout=10)
    print("Target process terminated.")

    sock.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        print("Error during dap test:", ex)
        sys.exit(1)