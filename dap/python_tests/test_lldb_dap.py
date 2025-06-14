#!/usr/bin/env python3
"""
A minimal LLDB-DAP client test script that mimics the flow used in test_simple_breakpoint.py.
"""

import os
import sys
import json
import socket
import subprocess
import threading
import time
import re
import platform

# Global variables to help manage DAP messages
next_seq = 1
responses = {}
events = {}

def parse_lldb_result(result_value):
    """
    Parse an LLDB expression evaluation result to extract the actual value.

    Examples:
    "(lldb) expr -- a + b\n(int) $0 = 12\n" -> "12"
    "(int) $0 = 12" -> "12"
    "12" -> "12"

    Args:
        result_value: The string returned from LLDB evaluation

    Returns:
        Extracted value as string, or original string if no pattern matches
    """
    if not result_value:
        return None

    # Try to match full LLDB output with command
    match = re.search(r'\(lldb\).*\n\(\w+\)\s+\$\d+\s+=\s+(.+)', result_value)
    if match:
        return match.group(1).strip()

    # Try to match just the result part
    match = re.search(r'\(\w+\)\s+\$\d+\s+=\s+(.+)', result_value)
    if match:
        return match.group(1).strip()

    # If no patterns match, return the original value
    return result_value.strip()

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
    print(f"--> Sent (seq {message.get('seq')}, cmd: {message.get('command')}): {data}\n")

def read_dap_message(sock):
    """Read a DAP message from the socket. Blocks until complete."""
    header = b""
    while b"\r\n\r\n" not in header:
        chunk = sock.recv(1)
        if not chunk:
            raise ConnectionError("Socket closed while reading header")
        header += chunk
    header_text, _ = header.split(b"\r\n\r\n", 1)
    m = re.search(rb"Content-Length:\s*(\d+)", header_text)
    if not m:
        raise ValueError("Content-Length header not found")
    length = int(m.group(1))
    body = b""
    while len(body) < length:
        body += sock.recv(length - len(body))
    message = json.loads(body.decode('utf-8'))
    print(f"<-- Received: {json.dumps(message)}\n")
    return message

def dap_receiver(sock):
    """Thread function that continuously reads and processes DAP messages."""
    while True:
        try:
            msg = read_dap_message(sock)
        except Exception as e:
            print(f"Receiver terminating: {e}")
            break
        msg_type = msg.get("type")
        # We key responses by request_seq for responses,
        # and simply append events to a list.
        if msg_type == "response":
            req_seq = msg.get("request_seq")
            responses[req_seq] = msg
        elif msg_type == "event":
            event_name = msg.get("event")
            events.setdefault(event_name, []).append(msg)
            print(f"Received event: {event_name}")
        else:
            print("Unknown message type", msg)

def wait_for_event(event_name, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if event_name in events and events[event_name]:
            return events[event_name].pop(0)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event {event_name}")

def wait_for_response(seq, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if seq in responses:
            return responses.pop(seq)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

def stream_output(proc, buffer):
    """Continuously read lines from proc.stdout and append them to buffer."""
    for line in iter(proc.stdout.readline, b''):
        if not line:
            break
        buffer.append(line.decode('utf-8').rstrip())
    proc.stdout.close()

def main():
    # Find the lldb-dap binary
    lldb_dap_path = "/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap"
    if not os.path.exists(lldb_dap_path):
        print(f"Error: LLDB-DAP not found at {lldb_dap_path}")
        sys.exit(1)

    # Find the workspace root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    workspace_root = os.path.dirname(os.path.dirname(script_dir))

    # Path to the test program
    test_program_src = os.path.join(workspace_root, "dap", "test_data", "rust_program")

    # Build the test program
    print("Building test program...")
    try:
        subprocess.run(["cargo", "build"], cwd=test_program_src, check=True)
    except subprocess.CalledProcessError:
        print("Error building test program")
        sys.exit(1)

    # Path to the binary
    target_program = os.path.join(workspace_root, "target", "debug", "rust_program")
    if platform.system() == "Windows":
        target_program += ".exe"

    if not os.path.exists(target_program):
        print(f"Error: Compiled binary not found at {target_program}")
        sys.exit(1)

    print(f"Using binary: {target_program}")

    # Start lldb-dap on a specific port
    lldb_port = 9123
    print(f"Starting lldb-dap on port {lldb_port}...")
    lldb_proc = subprocess.Popen(
        [lldb_dap_path, "--port", str(lldb_port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT
    )

    # Buffer to capture output
    output_buffer = []
    output_thread = threading.Thread(target=stream_output, args=(lldb_proc, output_buffer), daemon=True)
    output_thread.start()

    # Give lldb-dap time to start
    time.sleep(1)

    # Connect to lldb-dap
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect(("127.0.0.1", lldb_port))
        print("Connected to lldb-dap.")
    except ConnectionRefusedError:
        print("Failed to connect to lldb-dap")
        lldb_proc.terminate()
        sys.exit(1)

    # Start DAP message receiver thread
    recv_thread = threading.Thread(target=dap_receiver, args=(sock,), daemon=True)
    recv_thread.start()

    try:
        # Step 1: Send initialize request
        init_seq = next_sequence()
        init_req = {
            "seq": init_seq,
            "type": "request",
            "command": "initialize",
            "arguments": {
                "clientID": "wayfind-test",
                "clientName": "Wayfind LLDB Test",
                "adapterID": "lldb",
                "pathFormat": "path",
                "linesStartAt1": True,
                "columnsStartAt1": True,
                "supportsVariableType": True,
                "supportsRunInTerminalRequest": False
            }
        }
        send_dap_message(sock, init_req)
        init_resp = wait_for_response(init_seq)
        print(f"Initialize response: {json.dumps(init_resp, indent=2)}")

        # Step 2: Send launch request (equivalent to attach in the Python example)
        launch_seq = next_sequence()
        launch_req = {
            "seq": launch_seq,
            "type": "request",
            "command": "launch",
            "arguments": {
                "program": target_program,
                "args": [],
                "cwd": os.path.dirname(target_program),
                "stopOnEntry": False
            }
        }
        send_dap_message(sock, launch_req)
        time.sleep(0.2)  # Just like in debugpy example, give the server a moment

        # Step 3: Now wait for initialized event
        print("Waiting for initialized event...")
        initialized_event = wait_for_event("initialized", timeout=5)
        print(f"Initialized event received: {json.dumps(initialized_event, indent=2)}")
        print("Initialization complete")

        # Step 4: Set breakpoints
        bp_seq = next_sequence()
        bp_req = {
            "seq": bp_seq,
            "type": "request",
            "command": "setBreakpoints",
            "arguments": {
                "source": {
                    "path": os.path.join(test_program_src, "src", "main.rs")
                },
                "breakpoints": [
                    {"line": 10}
                ],
                "sourceModified": False
            }
        }
        send_dap_message(sock, bp_req)
        bp_resp = wait_for_response(bp_seq)
        print(f"Breakpoints response: {json.dumps(bp_resp, indent=2)}")

        # Step 5: Configuration done
        config_seq = next_sequence()
        config_req = {
            "seq": config_seq,
            "type": "request",
            "command": "configurationDone"
        }
        send_dap_message(sock, config_req)
        config_resp = wait_for_response(config_seq)
        print(f"ConfigurationDone response: {json.dumps(config_resp, indent=2)}")

        # Step 8: Wait for the breakpoint hit (another stopped event)
        print("Waiting for breakpoint hit...")
        breakpoint_hit_event = wait_for_event("stopped", timeout=5)
        print(f"Breakpoint hit event: {json.dumps(breakpoint_hit_event, indent=2)}")
        thread_id = breakpoint_hit_event.get("body", {}).get("threadId", 1)

        next_seq = next_sequence()
        next_req = {
            "seq": next_seq,
            "type": "request",
            "command": "next",
            "arguments": {
                "threadId": thread_id
            }
        }
        send_dap_message(sock, next_req)
        next_resp = wait_for_response(next_seq)
        print(f"Next response: {json.dumps(next_resp, indent=2)}")

        # Step 9: Get stack trace to get the frame ID
        stack_seq = next_sequence()
        stack_req = {
            "seq": stack_seq,
            "type": "request",
            "command": "stackTrace",
            "arguments": {
                "threadId": thread_id,
                "startFrame": 0,
                "levels": 1
            }
        }
        send_dap_message(sock, stack_req)
        stack_resp = wait_for_response(stack_seq)
        print(f"Stack trace response: {json.dumps(stack_resp, indent=2)}")
        frames = stack_resp.get("body", {}).get("stackFrames", [])
        frame_id = frames[0].get("id") if frames else None
        print(f"Using frameId: {frame_id}")

        # Step 10: Evaluate an expression
        eval_seq = next_sequence()
        eval_args = {
            "expression": "expr -- result",
            "context": "repl"
        }
        if frame_id:
            eval_args["frameId"] = frame_id
        else:
            raise AssertionError("No frame ID available")
        eval_req = {
            "seq": eval_seq,
            "type": "request",
            "command": "evaluate",
            "arguments": eval_args
        }
        send_dap_message(sock, eval_req)
        eval_resp = wait_for_response(eval_seq)
        print(f"Evaluate response: {json.dumps(eval_resp, indent=2)}")
        result_value = eval_resp.get("body", {}).get("result")
        print(f"Value of 'result' at breakpoint: {parse_lldb_result(result_value)}")

        terminate_seq = next_sequence()
        terminate_req = {
            "seq": terminate_seq,
            "type": "request",
            "command": "terminate",
            "arguments": {
                "restart": False
            }
        }
        send_dap_message(sock, terminate_req)

    except Exception as e:
        print(f"Error during test: {e}")
    finally:
        sock.close()
        lldb_proc.terminate()
        lldb_proc.wait()

        # Print captured output
        print("\n----- Captured LLDB-DAP Output -----")
        for line in output_buffer:
            print(line)

        print("Test completed")

if __name__ == "__main__":
    main()
