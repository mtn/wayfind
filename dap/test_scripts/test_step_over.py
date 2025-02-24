#!/usr/bin/env python3
"""
A minimal DAP client that:
 – launches the target script (a.py) with debugpy;
 – connects to debugpy over TCP;
 – sends an initialize request, then an attach request;
 – sends setBreakpoints and configurationDone requests during the configuration phase;
 – waits for a breakpoint hit (stopped event),
 – requests a stack trace to obtain a frame id,
 – sets another breakpoint while stopped,
 – continues until hitting the new breakpoint,
 – finally sends continue until the process terminates,
 – waits for the target process to terminate, then exits.

Note: This is a bare‐bones implementation meant for testing, refactored to use helper functions.
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
    sock.sendall(header.encode('utf-8') + data.encode('utf-8'))
    print(f"--> Sent (seq {message.get('seq')}, cmd: {message.get('command')}): {data}\n")

def read_dap_message(sock):
    """Read a single DAP message from the socket. This blocks until a full message is read."""
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
    """Thread function that continuously reads DAP messages and categorizes them into global dicts."""
    while True:
        try:
            msg = read_dap_message(sock)
        except:
            print("Receiver terminating.")
            break
        msg_type = msg.get("type")
        if msg_type == "response":
            req_seq = msg.get("request_seq")
            responses[req_seq] = msg
        elif msg_type == "event":
            events.setdefault(msg.get("event"), []).append(msg)
        else:
            print("Unknown message type", msg)

def wait_for_event(event_name, timeout=10):
    """Wait for a specific event to appear in the global 'events' dict."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if event_name in events and events[event_name]:
            return events[event_name].pop(0)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event {event_name}")

def wait_for_response(seq, timeout=10):
    """Wait for the response corresponding to the given sequence number."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if seq in responses:
            return responses.pop(seq)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

def stream_output(proc, buffer):
    """Continuously read lines from proc.stdout and append them to the provided buffer."""
    for line in iter(proc.stdout.readline, ''):
        if not line:
            break
        buffer.append(line.rstrip())
    proc.stdout.close()

# ------------------ Refactored Helper Functions ------------------ #

def launch_target_script_with_debugpy(target_script, debugpy_port):
    """
    Launch the target script with debugpy listening on the specified port.
    Returns a tuple of (subprocess.Popen, output_buffer).
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
    output_thread = threading.Thread(
        target=stream_output,
        args=(proc, output_buffer),
        daemon=True
    )
    output_thread.start()
    # Give the process some time to start up
    time.sleep(1)
    return proc, output_buffer, output_thread

def connect_to_debugpy(debugpy_port):
    """
    Create a socket connection to debugpy on the specified port
    and start a receiver thread. Returns (sock, recv_thread).
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", debugpy_port))
    print("Connected to debugpy.")

    recv_thread = threading.Thread(target=dap_receiver, args=(sock,), daemon=True)
    recv_thread.start()

    return sock, recv_thread

def send_initialize_request(sock):
    """Send the 'initialize' request to the debug adapter and wait for response."""
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
    """Send the 'attach' request to the debug adapter and wait for response (if any)."""
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
    # We don't immediately receive a response, so we might wait a bit if needed
    time.sleep(0.2)

def send_set_breakpoints_request(sock, target_script, lines):
    """Send a 'setBreakpoints' request for the given lines in target_script."""
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
    """Send the 'configurationDone' request."""
    conf_seq = next_sequence()
    conf_req = {
        "seq": conf_seq,
        "type": "request",
        "command": "configurationDone",
        "arguments": {}
    }
    send_dap_message(sock, conf_req)
    return conf_seq

def send_next_request(sock, thread_id):
    """Send the 'next' request."""
    next_seq = next_sequence()
    conf_req = {
        "seq": next_seq,
        "type": "request",
        "command": "next",
        "arguments": {
            "threadId": thread_id
        }
    }
    send_dap_message(sock, conf_req)
    return next_seq

def request_stack_trace(sock, thread_id, start_frame=0, levels=1):
    """Send a 'stackTrace' request and return its response."""
    st_seq = next_sequence()
    st_req = {
        "seq": st_seq,
        "type": "request",
        "command": "stackTrace",
        "arguments": {
            "threadId": thread_id,
            "startFrame": start_frame,
            "levels": levels
        }
    }
    send_dap_message(sock, st_req)
    return st_seq

def send_continue_request(sock, thread_id):
    """Send a 'continue' request for the given thread."""
    cont_seq = next_sequence()
    cont_req = {
        "seq": cont_seq,
        "type": "request",
        "command": "continue",
        "arguments": {"threadId": thread_id}
    }
    send_dap_message(sock, cont_req)
    return cont_seq

# ------------------ Main Function ------------------ #

def main():
    # Step 1: Launch target script with debugpy
    debugpy_port = 5678
    target_script = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "test_data", "a.py")
    )
    proc, output_buffer, output_thread = launch_target_script_with_debugpy(target_script, debugpy_port)

    # Step 2: Connect to debugpy
    sock, recv_thread = connect_to_debugpy(debugpy_port)

    # Step 3: Send initialize
    init_resp = send_initialize_request(sock)
    print("Received initialize response:", init_resp)

    # Step 4: Send attach request
    send_attach_request(sock, debugpy_port)

    # Wait for the "initialized" event
    _ = wait_for_event("initialized")
    print("Initialization complete")

    # Step 5: Send setBreakpoints
    bp_seq = send_set_breakpoints_request(sock, target_script, [19])
    bp_resp = wait_for_response(bp_seq)
    print("Breakpoints response:", bp_resp)
    if not bp_resp.get("success"):
        print("Error setting breakpoints:", bp_resp.get("message"))

    # Step 6: Send configurationDone
    conf_seq = send_configuration_done_request(sock)
    conf_resp = wait_for_response(conf_seq)
    print("ConfigurationDone response:", conf_resp)

    # Step 7: Wait for the "stopped" event
    print("Waiting for the target to hit the breakpoint (stopped event)...")
    stopped_event = wait_for_event("stopped", timeout=15)
    print("Received stopped event:", stopped_event)
    thread_id = stopped_event.get("body", {}).get("threadId", 1)

    # Request a stack trace to get the correct frame id
    st_seq = request_stack_trace(sock, thread_id)
    st_resp = wait_for_response(st_seq)
    print("StackTrace response:", st_resp)
    frames = st_resp.get("body", {}).get("stackFrames", [])
    frame_id = frames[0].get("id") if frames else None
    print("Using frameId:", frame_id)
    line_num = st_resp["body"]["stackFrames"][0]["line"]
    assert line_num == 19

    # Step over
    next_seq = send_next_request(sock, thread_id)
    next_resp = wait_for_response(next_seq)
    print("Next reponse:", next_resp)

    # Get stack trace, verify line number
    st_seq = request_stack_trace(sock, thread_id)
    st_resp = wait_for_response(st_seq)
    line_num = st_resp["body"]["stackFrames"][0]["line"]
    print(f"stopped on line {line_num}")
    assert line_num == 20

    # Step 9: Continue again
    cont_seq = send_continue_request(sock, thread_id)
    cont_resp = wait_for_response(cont_seq)
    print("Continue response:", cont_resp)

    # Wait for terminate
    _ = wait_for_event("terminated")
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