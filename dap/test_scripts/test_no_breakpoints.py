#!/usr/bin/env python3
"""
A minimal DAP client that tests a 'no-breakpoints' scenario.
This version captures the output of the target script into a buffer,
which is printed at the end.
"""

import os
import sys
import json
import socket
import subprocess
import threading
import time
import re

next_seq = 1
responses = {}
events = {}

def next_sequence():
    global next_seq
    seq = next_seq
    next_seq += 1
    return seq

def send_dap_message(sock, message):
    data = json.dumps(message)
    header = f"Content-Length: {len(data)}\r\n\r\n"
    sock.sendall(header.encode("utf-8") + data.encode("utf-8"))
    print(f"--> Sent (seq {message.get('seq')}, cmd: {message.get('command')}): {data}\n")

def read_dap_message(sock):
    header = b""
    while b"\r\n\r\n" not in header:
        chunk = sock.recv(1)
        if not chunk:
            raise ConnectionError("Socket closed while reading DAP header.")
        header += chunk
    header_text, _ = header.split(b"\r\n\r\n", 1)
    m = re.search(rb"Content-Length:\s*(\d+)", header_text)
    if not m:
        raise ValueError("Content-Length header not found.")
    length = int(m.group(1))

    body = b""
    while len(body) < length:
        body += sock.recv(length - len(body))
    message = json.loads(body.decode("utf-8"))
    print(f"<-- Received: {json.dumps(message)}\n")
    return message

def dap_receiver(sock):
    while True:
        try:
            msg = read_dap_message(sock)
        except Exception as e:
            print("Receiver terminating:", e)
            break
        msg_type = msg.get("type")
        if msg_type == "response":
            req_seq = msg.get("request_seq")
            responses[req_seq] = msg
        elif msg_type == "event":
            events.setdefault(msg.get("event"), []).append(msg)
        else:
            print("Unknown message type received:", msg)

def wait_for_event(name, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if name in events and events[name]:
            return events[name].pop(0)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event: {name}")

def wait_for_response(seq, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if seq in responses:
            return responses.pop(seq)
        time.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

# A helper function that continuously reads the target's output and
# appends it to a buffer.
def stream_output(proc, buffer):
    for line in iter(proc.stdout.readline, ''):
        if not line:
            break
        buffer.append(line.rstrip())
    proc.stdout.close()

def main():
    # Buffer to capture the output of the target script
    output_buffer = []

    this_dir = os.path.dirname(__file__)
    target_script = os.path.abspath(os.path.join(this_dir, "test_data", "a.py"))
    debugpy_port = 5678

    # 1) Launch Python with debugpy, capturing its output.
    cmd = [
        sys.executable, "-m", "debugpy",
        "--listen", f"127.0.0.1:{debugpy_port}",
        "--wait-for-client",
        target_script
    ]
    print("Launching target script:", " ".join(cmd))
    proc = subprocess.Popen(cmd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT,
                            universal_newlines=True,
                            bufsize=1)

    # Start a thread to continuously read the target's output into output_buffer.
    output_thread = threading.Thread(target=stream_output, args=(proc, output_buffer), daemon=True)
    output_thread.start()

    time.sleep(1)  # Give the target a moment to start

    # 2) Connect over TCP to debugpy.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect(("127.0.0.1", debugpy_port))
    print("Connected to debugpy.")

    recv_thread = threading.Thread(target=dap_receiver, args=(sock,), daemon=True)
    recv_thread.start()

    # 3) Initialize.
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
        },
    }
    send_dap_message(sock, init_req)
    init_resp = wait_for_response(init_seq)
    print("Initialize response:", init_resp)

    # 4) Attach.
    attach_seq = next_sequence()
    attach_req = {
        "seq": attach_seq,
        "type": "request",
        "command": "attach",
        "arguments": {
            "host": "127.0.0.1",
            "port": debugpy_port,
        },
    }
    send_dap_message(sock, attach_req)

    # Wait for "initialized" event.
    _ = wait_for_event("initialized")
    print("Received 'initialized' event.")

    # 5) Since we are NOT setting any breakpoints, we skip setBreakpoints.
    #    Now send configurationDone so the script starts running.
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

    # 6) Watch for 'terminated' or 'exited' events, or wait until the process ends.
    done = False
    while not done:
        try:
            evt = wait_for_event("terminated", timeout=0.5)
            print("Received 'terminated' event:", evt)
            done = True
        except TimeoutError:
            # Check if the process is done
            ret = proc.poll()
            if ret is not None:
                print("Process ended on its own.")
                done = True
            time.sleep(0.2)

    sock.close()
    print("Socket closed, done.")

    # Ensure the output thread has completed
    output_thread.join(timeout=1.0)

    # Print the collected output at the end.
    print("\n----- Captured Target Output -----")
    for line in output_buffer:
        print(line)

if __name__ == "__main__":
    main()