#!/usr/bin/env python3
"""
A minimal DAP client test script for testing the terminate request:

  – Launch the target script (a.py) with debugpy.
  – Connect over TCP.
  – Send initialize and attach requests.
  – Send setBreakpoints and configurationDone requests.
  – Wait for the debuggee to hit a breakpoint (stopped event).
  – Then send a terminate request.
  – Wait for a "terminated" event and exit.

This demonstrates how a DAP client can gracefully terminate the session.
"""

import os
import sys
import json
import socket
import subprocess
import threading
import time
import re

# Global variables for DAP messaging
next_seq = 1
responses = {}
events = {}

def next_sequence():
    """Generate a unique sequence id for each DAP request."""
    global next_seq
    seq = next_seq
    next_seq += 1
    return seq

def send_dap_message(sock, message):
    """Send a DAP message over the socket with the required headers."""
    data = json.dumps(message)
    header = f"Content-Length: {len(data)}\r\n\r\n"
    sock.sendall(header.encode("utf-8") + data.encode("utf-8"))
    print(f"--> Sent (seq {message.get('seq')}, cmd: {message.get('command')}): {data}\n")

def read_dap_message(sock):
    """Read a full DAP message from the socket; blocks until message is complete."""
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
    message = json.loads(body.decode("utf-8"))
    print(f"<-- Received: {json.dumps(message)}\n")
    return message

def dap_receiver(sock):
    """Continuously read DAP messages and store responses and events globally."""
    while True:
        try:
            msg = read_dap_message(sock)
        except Exception as ex:
            print("Receiver terminating:", ex)
            break
        msg_type = msg.get("type")
        if msg_type == "response":
            req_seq = msg.get("request_seq")
            responses[req_seq] = msg
        elif msg_type == "event":
            events.setdefault(msg.get("event"), []).append(msg)
        else:
            print("Unknown message type:", msg)

def wait_for_event(event_name, timeout=10):
    """Wait until a DAP event with the given name is received."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if event_name in events and events[event_name]:
            return events[event_name].pop(0)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event {event_name}")

def wait_for_response(seq, timeout=10):
    """Wait until the response for the given sequence is received."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if seq in responses:
            return responses.pop(seq)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

def stream_output(proc, buffer):
    """Continuously read lines from proc.stdout and append them to buffer."""
    for line in iter(proc.stdout.readline, ''):
        if not line:
            break
        buffer.append(line.rstrip())
    proc.stdout.close()

# ------------------ Helper Functions ------------------ #

def launch_target_script_with_debugpy(target_script, debugpy_port):
    """
    Launch the target script (a.py) with debugpy listening on the specified port.
    Returns a tuple: (subprocess.Popen, output_buffer, output_thread).
    """
    output_buffer = []
    launcher_cmd = [
        sys.executable, "-m", "debugpy",
        "--listen", f"127.0.0.1:{debugpy_port}",
        "--wait-for-client",
        target_script
    ]
    print("Launching target script with debugpy:", " ".join(launcher_cmd))
    proc = subprocess.Popen(
        launcher_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
        bufsize=1
    )
    output_thread = threading.Thread(target=stream_output, args=(proc, output_buffer), daemon=True)
    output_thread.start()
    # Allow the script time to start
    time.sleep(1)
    return proc, output_buffer, output_thread

def connect_to_debugpy(debugpy_port):
    """
    Connect to debugpy over TCP and launch the receiver thread.
    Returns (sock, recv_thread).
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", debugpy_port))
    print("Connected to debugpy.")
    recv_thread = threading.Thread(target=dap_receiver, args=(sock,), daemon=True)
    recv_thread.start()
    return sock, recv_thread

def send_initialize_request(sock):
    """
    Send the 'initialize' request to the debug adapter and wait for its response.
    """
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
    return wait_for_response(init_seq)

def send_attach_request(sock, debugpy_port):
    """
    Send the 'attach' request with host and port.
    """
    attach_seq = next_sequence()
    attach_req = {
        "seq": attach_seq,
        "type": "request",
        "command": "attach",
        "arguments": {
            "host": "127.0.0.1",
            "port": debugpy_port
        }
    }
    send_dap_message(sock, attach_req)
    time.sleep(0.2)

def send_set_breakpoints_request(sock, target_script, lines):
    """
    Send 'setBreakpoints' request for specified lines in target_script.
    """
    bp_seq = next_sequence()
    set_bp_req = {
        "seq": bp_seq,
        "type": "request",
        "command": "setBreakpoints",
        "arguments": {
            "source": {
                "path": target_script,
                "name": os.path.basename(target_script)
            },
            "breakpoints": [{"line": ln} for ln in lines],
            "sourceModified": False
        }
    }
    send_dap_message(sock, set_bp_req)
    return bp_seq

def send_configuration_done_request(sock):
    """
    Send the 'configurationDone' request.
    """
    conf_seq = next_sequence()
    conf_req = {
        "seq": conf_seq,
        "type": "request",
        "command": "configurationDone",
        "arguments": {}
    }
    send_dap_message(sock, conf_req)
    return conf_seq

def send_terminate_request(sock):
    """
    Send the 'terminate' request to the debug adapter.
    According to the spec, this is just an acknowledgement – the adapter will then send
    a 'terminated' event.
    """
    term_seq = next_sequence()
    term_req = {
        "seq": term_seq,
        "type": "request",
        "command": "terminate",
        "arguments": {
            "restart": False
        }
    }
    send_dap_message(sock, term_req)
    return term_seq

# ------------------ Main Function ------------------ #

def main():
    debugpy_port = 5678
    target_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "test_data", "a.py"))

    # Launch the target with debugpy.
    proc, output_buffer, output_thread = launch_target_script_with_debugpy(target_script, debugpy_port)

    # Connect to the debug adapter.
    sock, recv_thread = connect_to_debugpy(debugpy_port)

    # Send initialize request.
    init_resp = send_initialize_request(sock)
    print("Received initialize response:", init_resp)

    # Send attach request.
    send_attach_request(sock, debugpy_port)

    # Wait for "initialized" event.
    _ = wait_for_event("initialized")
    print("Initialization complete")

    # Set a breakpoint – here, for example, at line 24 in a.py.
    bp_line = 24
    bp_seq = send_set_breakpoints_request(sock, target_script, [bp_line])
    bp_resp = wait_for_response(bp_seq)
    print("Breakpoints response:", bp_resp)
    if not bp_resp.get("success"):
        print("Error setting breakpoints:", bp_resp.get("message"))

    # Send configurationDone request.
    conf_seq = send_configuration_done_request(sock)
    conf_resp = wait_for_response(conf_seq)
    print("ConfigurationDone response:", conf_resp)

    # Wait for the target script to hit the breakpoint.
    print("Waiting for stopped event (target hit breakpoint)...")
    stopped_event = wait_for_event("stopped", timeout=15)
    print("Received stopped event:", stopped_event)

    # Now send the terminate request.
    print("Sending terminate request...")
    term_seq = send_terminate_request(sock)
    term_resp = wait_for_response(term_seq, timeout=15)
    print("Terminate response:", term_resp)

    # Finally, wait for the terminated event.
    terminated_event = wait_for_event("terminated", timeout=15)
    print("Received terminated event:", terminated_event)

    # Cleanup: close socket and join output thread.
    sock.close()
    output_thread.join(timeout=1.0)

    print("\n----- Captured Target Output -----")
    for line in output_buffer:
        print(line)

if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        print("Error during dap test:", ex)
        sys.exit(1)