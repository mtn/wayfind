#!/usr/bin/env python3
"""
IMPORTANT: "restart" isn't handled by debugpy, so we need to terminate and restart the debugpy session manually.

A minimal DAP client test script that simulates restart by terminating and
restarting the debugpy session:

 – Launches the target script (a.py) with debugpy.
 – Connects over TCP.
 – Sends initialize and attach requests.
 – Sends setBreakpoints and configurationDone requests.
 – Waits for a breakpoint hit (stopped event) and requests a stack trace.
 – Terminates the current debug session.
 – Relaunches the target script with debugpy.
 – Repeats handshake (initialize/attach/breakpoints/configurationDone).
 – Waits for breakpoint hit again and verifies.
 – Finally closes the connection.
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
    """Read a full DAP message from the socket."""
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
    """Continuously read DAP messages and store them globally."""
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
    """Wait until an event is available in the global events dict."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if event_name in events and events[event_name]:
            return events[event_name].pop(0)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event {event_name}")

def wait_for_response(seq, timeout=10):
    """Wait until a response for a given sequence is available."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if seq in responses:
            return responses.pop(seq)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

def stream_output(proc, buffer):
    """Continuously read lines from process stdout and append to buffer."""
    for line in iter(proc.stdout.readline, ''):
        if not line:
            break
        buffer.append(line.rstrip())
    proc.stdout.close()

# ------------------ Helper Functions ------------------ #

def launch_target_script_with_debugpy(target_script, debugpy_port):
    """
    Launch the target script with debugpy listening on the specified port.
    Returns (subprocess.Popen, output_buffer, output_thread).
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
    time.sleep(1)
    return proc, output_buffer, output_thread

def connect_to_debugpy(debugpy_port):
    """
    Create a socket connection to debugpy on the specified port and start a receiver thread.
    Returns (sock, recv_thread).
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", debugpy_port))
    print("Connected to debugpy.")
    recv_thread = threading.Thread(target=dap_receiver, args=(sock,), daemon=True)
    recv_thread.start()
    return sock, recv_thread

def send_initialize_request(sock):
    """Send an 'initialize' request and wait for a response."""
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
            "supportsEvaluateForHovers": True,
            "supportsRestartRequest": True,
        }
    }
    send_dap_message(sock, init_req)
    return wait_for_response(init_seq)

def send_attach_request(sock, debugpy_port):
    """Send an 'attach' request to the adapter."""
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
    """Send a 'setBreakpoints' request for specified lines."""
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

def request_stack_trace(sock, thread_id, start_frame=0, levels=1):
    """Send a 'stackTrace' request and return its sequence number."""
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

def restart_debug_session(proc, sock, debugpy_port, target_script):
    """
    Ends the current debug session by closing the socket and terminating the process.
    Then resets our globals and launches a new debugpy process.
    Returns new (proc, sock, output_buffer, output_thread).
    """
    print("Restarting the debug session by terminating the current process...")
    try:
        sock.close()
    except Exception as ex:
        print("Error closing socket:", ex)
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception as ex:
        print("Error terminating process:", ex)
    # Reset global state
    global next_seq, responses, events
    next_seq = 1
    responses.clear()
    events.clear()

    # Relaunch a new debugpy process
    new_proc, new_output_buffer, new_output_thread = launch_target_script_with_debugpy(target_script, debugpy_port)
    new_sock, new_recv_thread = connect_to_debugpy(debugpy_port)
    return new_proc, new_sock, new_output_buffer, new_output_thread

# ------------------ Main Function ------------------ #

def main():
    debugpy_port = 5678
    target_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "test_data", "a.py"))

    # Initial launch with debugpy
    proc, output_buffer, output_thread = launch_target_script_with_debugpy(target_script, debugpy_port)
    sock, recv_thread = connect_to_debugpy(debugpy_port)

    # Establish handshake (initialize, attach, breakpoints, configurationDone)
    init_resp = send_initialize_request(sock)
    print("Received initialize response:", init_resp)

    send_attach_request(sock, debugpy_port)
    _ = wait_for_event("initialized")
    print("Initialization complete")

    bp_line = 24
    bp_seq = send_set_breakpoints_request(sock, target_script, [bp_line])
    bp_resp = wait_for_response(bp_seq)
    print("Breakpoints response:", bp_resp)
    if not bp_resp.get("success"):
        print("Error setting breakpoints:", bp_resp.get("message"))

    conf_seq = send_configuration_done_request(sock)
    conf_resp = wait_for_response(conf_seq)
    print("ConfigurationDone response:", conf_resp)

    print("Waiting for the target to hit the breakpoint (stopped event)...")
    stopped_event = wait_for_event("stopped", timeout=15)
    print("Received stopped event:", stopped_event)
    thread_id = stopped_event.get("body", {}).get("threadId", 1)

    st_seq = request_stack_trace(sock, thread_id)
    st_resp = wait_for_response(st_seq)
    print("StackTrace response:", st_resp)
    frames = st_resp.get("body", {}).get("stackFrames", [])
    if not frames:
        raise RuntimeError("No stack frames received")
    print("Breakpoint hit at line:", frames[0]["line"])
    assert frames[0]["line"] == bp_line

    # ----- Simulate restart by terminating and re-launching the debug adapter -----
    print("\n=== Restarting the debug session ===\n")
    proc, sock, output_buffer, output_thread = restart_debug_session(proc, sock, debugpy_port, target_script)

    # With the new process, perform handshake anew
    init_resp2 = send_initialize_request(sock)
    print("Received new initialize response:", init_resp2)

    send_attach_request(sock, debugpy_port)
    _ = wait_for_event("initialized", timeout=15)
    print("Initialization complete after restart")

    bp_seq2 = send_set_breakpoints_request(sock, target_script, [bp_line])
    bp_resp2 = wait_for_response(bp_seq2)
    print("Breakpoints response after restart:", bp_resp2)

    conf_seq2 = send_configuration_done_request(sock)
    conf_resp2 = wait_for_response(conf_seq2)
    print("ConfigurationDone response after restart:", conf_resp2)

    print("Waiting for the target to hit the breakpoint after restart...")
    stopped_event2 = wait_for_event("stopped", timeout=15)
    print("Received stopped event after restart:", stopped_event2)
    thread_id2 = stopped_event2.get("body", {}).get("threadId", 1)

    st_seq2 = request_stack_trace(sock, thread_id2)
    st_resp2 = wait_for_response(st_seq2)
    print("StackTrace response after restart:", st_resp2)
    frames2 = st_resp2.get("body", {}).get("stackFrames", [])
    if not frames2:
        raise RuntimeError("No stack frames received after restart")
    print("Breakpoint hit after restart at line:", frames2[0]["line"])
    assert frames2[0]["line"] == bp_line

    # Finish: close connection and print output
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