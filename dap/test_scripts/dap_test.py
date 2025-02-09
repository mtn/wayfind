#!/usr/bin/env python3
"""
A minimal DAP client that:
 – launches the target script (a.py) with debugpy;
 – connects to debugpy over TCP;
 – sends an initialize request, then an attach request;
 – sends setBreakpoints and configurationDone requests during the configuration phase;
 – waits for a breakpoint hit (stopped event),
 – requests a stack trace to obtain a frame id,
 – sends an evaluate request to inspect variable "next_val" at the breakpoint,
 – sends a continue request, then exits.
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
    t0 = time.time()
    while time.time() - t0 < timeout:
        for ev in events:
            if ev.get("event") == event_name:
                events.remove(ev)
                return ev
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event {event_name}")

def wait_for_response(seq, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if seq in responses:
            resp = responses.pop(seq)
            return resp
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

def main():
    # Adjust the target path (a.py should be in test_data subfolder).
    target_script = os.path.abspath(os.path.join(os.path.dirname(__file__), "test_data", "a.py"))
    debugpy_port = 5678

    # # Step 1: Launch target script with debugpy.
    # launcher_cmd = [
    #     sys.executable, "-m", "debugpy",
    #     "--listen", f"127.0.0.1:{debugpy_port}",
    #     "--wait-for-client",
    #     target_script
    # ]
    # print("Launching target script with debugpy:", " ".join(launcher_cmd))
    # proc = subprocess.Popen(launcher_cmd)
    # time.sleep(1)

    # Step 2: Connect to debugpy.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", debugpy_port))
    print("Connected to debugpy.")

    recv_thread = threading.Thread(target=dap_receiver, args=(sock,), daemon=True)
    recv_thread.start()

    # Step 3: Send initialize.
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
    print("Received initialize response:", init_resp)

    # Step 4: Send an attach request (since --wait-for-client was used).
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
    # Do not block waiting for attach response immediately; configuration phase follows.
    time.sleep(0.2)

    _ = wait_for_event("initialized")
    print("Initialization complete")

    # Step 5: Send setBreakpoints.
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
            "breakpoints": [
                {"line": 20}
            ],
            "sourceModified": False
        }
    }
    send_dap_message(sock, set_bp_req)
    bp_resp = wait_for_response(bp_seq)
    print("Breakpoints response:", bp_resp)
    if not bp_resp.get("success"):
        print("Error setting breakpoints:", bp_resp.get("message"))

    # Step 6: Send configurationDone.
    conf_seq = next_sequence()
    conf_req = {
        "seq": conf_seq,
        "type": "request",
        "command": "configurationDone",
        "arguments": {}
    }
    send_dap_message(sock, conf_req)
    conf_resp = wait_for_response(conf_seq)
    print("ConfigurationDone response:", conf_resp)

    # Now, wait for attach response.
    try:
        attach_resp = wait_for_response(attach_seq)
    except TimeoutError:
        attach_resp = None
        print("No attach response received (expected in some configurations).")
    else:
        print("Attach response:", attach_resp)

    # Step 7: Wait for a "stopped" event.
    print("Waiting for the target to hit the breakpoint (stopped event)...")
    try:
        stopped_event = wait_for_event("stopped", timeout=15)
    except TimeoutError as te:
        print("Error: Timeout waiting for stopped event.")
        raise te
    print("Received stopped event:", stopped_event)

    # Retrieve the thread id from the stopped event.
    thread_id = stopped_event.get("body", {}).get("threadId", 1)

    # New Step: Request a stack trace to get the correct frame id.
    st_seq = next_sequence()
    st_req = {
        "seq": st_seq,
        "type": "request",
        "command": "stackTrace",
        "arguments": {
            "threadId": thread_id,
            "startFrame": 0,
            "levels": 1
        }
    }
    send_dap_message(sock, st_req)
    st_resp = wait_for_response(st_seq)
    print("StackTrace response:", st_resp)
    frames = st_resp.get("body", {}).get("stackFrames", [])
    if not frames:
        print("No stack frames returned!")
        frame_id = None
    else:
        frame_id = frames[0].get("id")
        print("Using frameId:", frame_id)

    # Step 8: While stopped, send an evaluate request for variable "next_val".
    eval_seq = next_sequence()
    eval_arguments = {
        "expression": "next_val",
        "context": "hover",
    }
    # Include the frameId if we got one.
    if frame_id is not None:
        eval_arguments["frameId"] = frame_id
    eval_req = {
        "seq": eval_seq,
        "type": "request",
        "command": "evaluate",
        "arguments": eval_arguments
    }
    send_dap_message(sock, eval_req)
    eval_resp = wait_for_response(eval_seq)
    print("Evaluate response:", eval_resp)
    result_value = eval_resp.get("body", {}).get("result")
    print("Value of next_val at breakpoint:", result_value)

    # Step 9: Send a continue request.
    cont_seq = next_sequence()
    cont_req = {
        "seq": cont_seq,
        "type": "request",
        "command": "continue",
        "arguments": {"threadId": thread_id}
    }
    send_dap_message(sock, cont_req)
    cont_resp = wait_for_response(cont_seq)
    print("Continue response:", cont_resp)

    # proc.wait(timeout=10)
    # print("Target process terminated.")

    sock.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        print("Error during dap test:", ex)
        sys.exit(1)