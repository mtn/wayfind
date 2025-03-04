# wayfind/dap/rust_tests/test_lldb_dap.py
#!/usr/bin/env python3
"""
A minimal LLDB-DAP client test script.
"""

import os
import sys
import json
import socket
import subprocess
import threading
import time
import re
import shutil
import platform

# Global variables to help manage DAP messages
next_seq = 1
responses = {}
events = {}

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
            events.setdefault(msg.get("event"), []).append(msg)
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

def find_lldb_dap():
    """Find the LLDB-DAP executable."""
    if platform.system() == "Darwin":
        # On macOS, try to use the one from Xcode first
        xcode_path = "/Applications/Xcode.app/Contents/SharedFrameworks/LLDB.framework/Versions/A/Resources/lldb-dap"
        if os.path.exists(xcode_path):
            return xcode_path

        # Check if installed via Homebrew
        brew_path = "/usr/local/opt/llvm/bin/lldb-dap"
        if os.path.exists(brew_path):
            return brew_path

    # Try to find it in PATH
    lldb_dap_path = shutil.which("lldb-dap")
    if lldb_dap_path:
        return lldb_dap_path

    raise FileNotFoundError("Could not find lldb-dap executable")

def main():
    # Find the path to the test program
    script_dir = os.path.dirname(os.path.abspath(__file__))
    test_program_dir = os.path.abspath(os.path.join(script_dir, "..", "test_data", "rust_program"))
    print(test_program_dir)

    # Build the test program
    print("Building test program...")
    subprocess.run(["cargo", "build"], cwd=test_program_dir, check=True)

    # Path to the compiled binary, because of the workspace config it won't be in the rust project directory
    target_program = os.path.abspath(os.path.join(script_dir, "..", "..", "target", "debug", "rust_program"))

    # Find lldb-dap
    try:
        lldb_dap_path = find_lldb_dap()
        print(f"Using lldb-dap: {lldb_dap_path}")
    except FileNotFoundError as e:
        print(f"Error: {e}")
        print("Please install LLDB-DAP and make sure it's in your PATH")
        sys.exit(1)

    # Launch lldb-dap
    dap_port = 4711
    print(f"Launching lldb-dap on port {dap_port}...")
    lldb_proc = subprocess.Popen(
        [lldb_dap_path, "--port", str(dap_port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
        bufsize=1
    )

    # Give lldb-dap time to start
    time.sleep(1)

    # Connect to lldb-dap
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect(("127.0.0.1", dap_port))
        print("Connected to lldb-dap")
    except ConnectionRefusedError:
        print("Failed to connect to lldb-dap")
        lldb_proc.terminate()
        sys.exit(1)

    # Start the receiver thread
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
                "clientName": "Wayfind LLDB Tester",
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

        # Wait for initialized event
        initialized_event = wait_for_event("initialized")
        print(f"Initialized event: {json.dumps(initialized_event, indent=2)}")

        # Step 2: Configure launch
        launch_seq = next_sequence()
        launch_req = {
            "seq": launch_seq,
            "type": "request",
            "command": "launch",
            "arguments": {
                "program": target_program,
                "args": [],
                "cwd": os.path.dirname(target_program),
                "stopOnEntry": True
            }
        }
        send_dap_message(sock, launch_req)
        launch_resp = wait_for_response(launch_seq)
        print(f"Launch response: {json.dumps(launch_resp, indent=2)}")

        # Step 3: Set breakpoints
        bp_seq = next_sequence()
        bp_req = {
            "seq": bp_seq,
            "type": "request",
            "command": "setBreakpoints",
            "arguments": {
                "source": {
                    "path": os.path.join(test_program_dir, "src", "main.rs")
                },
                "breakpoints": [
                    {"line": 14}  # Line with calculate_sum call
                ],
                "sourceModified": False
            }
        }
        send_dap_message(sock, bp_req)
        bp_resp = wait_for_response(bp_seq)
        print(f"Breakpoints response: {json.dumps(bp_resp, indent=2)}")

        # Step 4: Configuration done
        config_seq = next_sequence()
        config_req = {
            "seq": config_seq,
            "type": "request",
            "command": "configurationDone"
        }
        send_dap_message(sock, config_req)
        config_resp = wait_for_response(config_seq)
        print(f"ConfigurationDone response: {json.dumps(config_resp, indent=2)}")

        # Wait for stopped event (should happen due to stopOnEntry)
        print("Waiting for stopped event (due to stopOnEntry)...")
        stopped_event = wait_for_event("stopped")
        print(f"Stopped event: {json.dumps(stopped_event, indent=2)}")
        thread_id = stopped_event.get("body", {}).get("threadId", 1)

        # Step 5: Continue to hit the breakpoint
        continue_seq = next_sequence()
        continue_req = {
            "seq": continue_seq,
            "type": "request",
            "command": "continue",
            "arguments": {
                "threadId": thread_id
            }
        }
        send_dap_message(sock, continue_req)
        continue_resp = wait_for_response(continue_seq)
        print(f"Continue response: {json.dumps(continue_resp, indent=2)}")

        # Wait for the breakpoint hit
        print("Waiting for breakpoint hit...")
        breakpoint_hit_event = wait_for_event("stopped")
        print(f"Breakpoint hit event: {json.dumps(breakpoint_hit_event, indent=2)}")
        thread_id = breakpoint_hit_event.get("body", {}).get("threadId", 1)

        # Get stack trace to get the frame ID
        stack_seq = next_sequence()
        stack_req = {
            "seq": stack_seq,
            "type": "request",
            "command": "stackTrace",
            "arguments": {
                "threadId": thread_id
            }
        }
        send_dap_message(sock, stack_req)
        stack_resp = wait_for_response(stack_seq)
        print(f"Stack trace response: {json.dumps(stack_resp, indent=2)}")

        # Get the frame ID from the stack trace
        frame_id = stack_resp.get("body", {}).get("stackFrames", [{}])[0].get("id")

        # Step 6: Evaluate an expression
        eval_seq = next_sequence()
        eval_req = {
            "seq": eval_seq,
            "type": "request",
            "command": "evaluate",
            "arguments": {
                "expression": "a + b",
                "frameId": frame_id,
                "context": "hover"
            }
        }
        send_dap_message(sock, eval_req)
        eval_resp = wait_for_response(eval_seq)
        print(f"Evaluate response: {json.dumps(eval_resp, indent=2)}")

        # Step 7: Continue to completion
        continue_seq = next_sequence()
        continue_req = {
            "seq": continue_seq,
            "type": "request",
            "command": "continue",
            "arguments": {
                "threadId": thread_id
            }
        }
        send_dap_message(sock, continue_req)
        continue_resp = wait_for_response(continue_seq)
        print(f"Final continue response: {json.dumps(continue_resp, indent=2)}")

        # Wait for the process to terminate
        print("Waiting for termination...")
        try:
            terminated_event = wait_for_event("terminated", timeout=5)
            print(f"Terminated event: {json.dumps(terminated_event, indent=2)}")
        except TimeoutError:
            print("No termination event received (may be normal for some adapters)")

        # Step 8: Disconnect
        disconnect_seq = next_sequence()
        disconnect_req = {
            "seq": disconnect_seq,
            "type": "request",
            "command": "disconnect",
            "arguments": {
                "terminateDebuggee": True
            }
        }
        send_dap_message(sock, disconnect_req)
        disconnect_resp = wait_for_response(disconnect_seq)
        print(f"Disconnect response: {json.dumps(disconnect_resp, indent=2)}")

    except Exception as e:
        print(f"Error during test: {e}")
    finally:
        sock.close()
        lldb_proc.terminate()
        lldb_proc.wait()
        print("Test completed")

if __name__ == "__main__":
    main()