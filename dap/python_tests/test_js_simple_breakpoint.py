#!/usr/bin/env python3
import os
import sys
import json
import asyncio
import subprocess
import time
import re
from pathlib import Path

# Global variables to help manage DAP messages
next_seq = 1
responses = {}
events = {}

# Path to the js-debug DAP server
DAP_SERVER_PATH = str(Path(__file__).resolve().parent.parent.parent / "vscode-js-debug" / "dist" / "src" / "dapDebugServer.js")
TARGET_SCRIPT = str(Path(__file__).resolve().parent.parent / "test_data" / "js" / "a.js")
DAP_PORT = 8123

def next_sequence():
    global next_seq
    seq = next_seq
    next_seq += 1
    return seq

async def send_dap_message(writer, message):
    """Send message as per DAP header format."""
    data = json.dumps(message)
    header = f"Content-Length: {len(data)}\r\n\r\n"
    writer.write(header.encode('utf-8') + data.encode('utf-8'))
    await writer.drain()
    print(f"--> Sent (seq {message.get('seq')}, cmd: {message.get('command')}): {data}\n")

async def read_dap_message(reader):
    """Read a DAP message from the reader. Blocks until complete."""
    header = b""
    while b"\r\n\r\n" not in header:
        chunk = await reader.read(1)
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
        chunk = await reader.read(length - len(body))
        if not chunk:
            raise ConnectionError("Socket closed while reading body")
        body += chunk
    message = json.loads(body.decode('utf-8'))
    print(f"<-- Received: {json.dumps(message)}\n")
    return message

async def handle_start_debugging_request(writer, request):
    """Handle a startDebugging request from the debug adapter."""
    print(f"Received startDebugging request: {request}")

    # Send a response to acknowledge the request
    response = {
        "seq": next_sequence(),
        "type": "response",
        "request_seq": request.get("seq"),
        "command": "startDebugging",
        "success": True
    }
    await send_dap_message(writer, response)
    print(f"Sent startDebugging response: {response}")

async def dap_receiver(reader, writer):
    """Async function that continuously reads and processes DAP messages."""
    while True:
        try:
            msg = await read_dap_message(reader)
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
        elif msg_type == "request":
            # Handle specific requests from the debug adapter
            if msg.get("command") == "startDebugging":
                await handle_start_debugging_request(writer, msg)
            else:
                print(f"Unhandled request type: {msg}")
        else:
            print("Unknown message type", msg)

async def wait_for_event(event_name, timeout=10):
    end_time = time.time() + timeout
    while time.time() < end_time:
        if event_name in events and events[event_name]:
            return events[event_name].pop(0)
        await asyncio.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for event {event_name}")

async def wait_for_response(seq, timeout=10):
    end_time = time.time() + timeout
    while time.time() < end_time:
        if seq in responses:
            return responses.pop(seq)
        await asyncio.sleep(0.1)
    raise TimeoutError(f"Timeout waiting for response to seq {seq}")

async def read_subprocess_output(proc, buffer):
    """Read subprocess output asynchronously."""
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        buffer.append(line.decode().rstrip())

async def main_async():
    # Buffer to capture the output
    output_buffer = []

    # Start DAP server
    print(f"Starting DAP server from: {DAP_SERVER_PATH}")
    # proc = await asyncio.create_subprocess_exec(
    #     "node", DAP_SERVER_PATH, str(DAP_PORT), "0.0.0.0",
    #     stdout=asyncio.subprocess.PIPE,
    #     stderr=asyncio.subprocess.STDOUT
    # )
    # output_task = asyncio.create_task(read_subprocess_output(proc, output_buffer))

    # Wait a moment for the server to start
    await asyncio.sleep(2)

    # Connect to DAP server
    reader, writer = await asyncio.open_connection("127.0.0.1", DAP_PORT)
    print("Connected to DAP server")

    # Start message receiver task
    recv_task = asyncio.create_task(dap_receiver(reader, writer))

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
            "supportsEvaluateForHovers": True,
            "supportsStartDebuggingRequest": True
        }
    }
    await send_dap_message(writer, init_req)
    init_resp = await wait_for_response(init_seq)
    print("Received initialize response:", init_resp)

    launch_seq = next_sequence()
    launch_req = {
        "seq": launch_seq,
        "type": "request",
        "command": "launch",
        "arguments": {
            "program": TARGET_SCRIPT,
            "args": [],
            "cwd": os.path.dirname(TARGET_SCRIPT),
            "stopOnEntry": True,
            "type": "pwa-node"
        }
    }
    await send_dap_message(writer, launch_req)
    await asyncio.sleep(0.2)

    # Wait for the "initialized" event sent by the adapter.
    _ = await wait_for_event("initialized")
    print("Initialization complete")

    # Step 5: Send setBreakpoints.
    bp_seq = next_sequence()
    set_bp_req = {
        "seq": bp_seq,
        "type": "request",
        "command": "setBreakpoints",
        "arguments": {
            "source": {
                "path": TARGET_SCRIPT,
                "name": os.path.basename(TARGET_SCRIPT)
            },
            "breakpoints": [
                {"line": 15}
            ],
            "sourceModified": False
        }
    }
    await send_dap_message(writer, set_bp_req)
    bp_resp = await wait_for_response(bp_seq)
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
    await send_dap_message(writer, conf_req)
    conf_resp = await wait_for_response(conf_seq)
    print("ConfigurationDone response:", conf_resp)

    # Step 7: Wait for the "stopped" event.
    print("Waiting for the target to hit the breakpoint (stopped event)...")
    # Removed the breakpoint() call as it was likely for debugging
    stopped_event = await wait_for_event("stopped", timeout=15)
    print("Received stopped event:", stopped_event)
    thread_id = stopped_event.get("body", {}).get("threadId", 1)

    # Request a stack trace to get the correct frame id.
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
    await send_dap_message(writer, st_req)
    st_resp = await wait_for_response(st_seq)
    print("StackTrace response:", st_resp)
    frames = st_resp.get("body", {}).get("stackFrames", [])
    frame_id = frames[0].get("id") if frames else None
    print("Using frameId:", frame_id)

    # Step 8: While stopped, send an evaluate request for "next_val".
    eval_seq = next_sequence()
    eval_args = {
        "expression": "nextVal",
        "context": "hover",
    }
    if frame_id:
        eval_args["frameId"] = frame_id
    eval_req = {
        "seq": eval_seq,
        "type": "request",
        "command": "evaluate",
        "arguments": eval_args
    }
    await send_dap_message(writer, eval_req)
    eval_resp = await wait_for_response(eval_seq)
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
    await send_dap_message(writer, cont_req)
    cont_resp = await wait_for_response(cont_seq)
    print("Continue response:", cont_resp)

    # Loop to send continue requests until no stopped event remains.
    while True:
        try:
            _ = await wait_for_event("stopped", timeout=1)
            print("Extra stopped event received; sending another continue.")
            cont_seq = next_sequence()
            cont_req = {
                "seq": cont_seq,
                "type": "request",
                "command": "continue",
                "arguments": {"threadId": thread_id}
            }
            await send_dap_message(writer, cont_req)
            extra_cont = await wait_for_response(cont_seq)
            print("Extra continue response:", extra_cont)
        except TimeoutError:
            break

    # Now, wait for the target process to terminate.
    # await proc.wait()  # You could add a longer timeout here, if needed.
    print("Target process terminated.")

    writer.close()
    await writer.wait_closed()

    # Wait for the output task to complete
    # await output_task
    # print("\n----- Captured Target Output -----")
    # for line in output_buffer:
    #     print(line)

def main():
    asyncio.run(main_async())

if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        print("Error during dap test:", ex)
        sys.exit(1)