#!/usr/bin/env python3
import os
import sys
import json
import asyncio
import subprocess
import time
import re
from pathlib import Path

# Path to the js-debug DAP server
DAP_SERVER_PATH = str(Path(__file__).resolve().parent.parent.parent / "vscode-js-debug" / "dist" / "src" / "dapDebugServer.js")
TARGET_SCRIPT = str(Path(__file__).resolve().parent.parent / "test_data" / "js" / "a.js")
DAP_PORT = 8123

class DapConnection:
    def __init__(self, name, reader, writer):
        self.name = name
        self.reader = reader
        self.writer = writer
        self.seq_counter = 1
        self.responses = {}
        self.events = {}

    def next_sequence(self):
        """Get next sequence number for this connection"""
        seq = self.seq_counter
        self.seq_counter += 1
        return seq

    async def send_dap_message(self, message):
        """Send message as per DAP header format."""
        data = json.dumps(message)
        header = f"Content-Length: {len(data)}\r\n\r\n"
        self.writer.write(header.encode('utf-8') + data.encode('utf-8'))
        await self.writer.drain()
        print(f"--> Sent [{self.name}] (seq {message.get('seq')}, cmd: {message.get('command')}): {data}\n")

    async def read_dap_message(self):
        """Read a DAP message from the reader. Blocks until complete."""
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = await self.reader.read(1)
            if not chunk:
                raise ConnectionError(f"[{self.name}] Socket closed while reading header")
            header += chunk
        header_text, _ = header.split(b"\r\n\r\n", 1)
        m = re.search(rb"Content-Length:\s*(\d+)", header_text)
        if not m:
            raise ValueError(f"[{self.name}] Content-Length header not found")
        length = int(m.group(1))
        body = b""
        while len(body) < length:
            chunk = await self.reader.read(length - len(body))
            if not chunk:
                raise ConnectionError(f"[{self.name}] Socket closed while reading body")
            body += chunk
        message = json.loads(body.decode('utf-8'))
        if "event" in message and message["event"] == "output":
            pass
        else:
            print(f"<-- Received [{self.name}]: {json.dumps(message)}\n")
        return message

    async def read_loop(self):
        """Async function that continuously reads and processes DAP messages."""
        print(f"Started read_loop for {self.name} connection")

        while True:
            try:
                msg = await self.read_dap_message()
            except Exception as e:
                print(f"Receiver [{self.name}] terminating: {e}")
                break

            msg_type = msg.get("type")
            if msg_type == "response":
                req_seq = msg.get("request_seq")
                self.responses[req_seq] = msg
                print(f"[{self.name}] Added response for seq {req_seq}")
            elif msg_type == "event":
                event_name = msg.get("event")
                self.events.setdefault(event_name, []).append(msg)
                if event_name != "output":
                    print(f"[{self.name}] Added event: {event_name}")
            elif msg_type == "request":
                if msg.get("command") == "startDebugging":
                    await self.handle_start_debugging_request(msg)
                else:
                    print(f"[{self.name}] Unhandled request type: {msg}")
            else:
                print(f"[{self.name}] Unknown message type", msg)

    async def wait_for_event(self, event_name, timeout=10):
        end_time = time.time() + timeout
        while time.time() < end_time:
            if event_name in self.events and self.events[event_name]:
                return self.events[event_name].pop(0)
            await asyncio.sleep(0.1)
        raise TimeoutError(f"[{self.name}] Timeout waiting for event {event_name}")

    async def wait_for_response(self, seq, timeout=10):
        end_time = time.time() + timeout
        while time.time() < end_time:
            if seq in self.responses:
                return self.responses.pop(seq)
            await asyncio.sleep(0.1)
        raise TimeoutError(f"[{self.name}] Timeout waiting for response to seq {seq}")

    async def send(self, command, arguments=None):
        """Helper method to send a request and return the sequence number"""
        seq = self.next_sequence()
        req = {
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments or {}
        }
        await self.send_dap_message(req)
        return seq

    async def handle_start_debugging_request(self, request):
        """Handle a startDebugging request from the debug adapter."""
        print(f"[{self.name}] Received startDebugging request: {request}")
        target_id = request["arguments"]["configuration"]["__pendingTargetId"]

        # Send a response to acknowledge the request
        response = {
            "seq": self.next_sequence(),
            "type": "response",
            "request_seq": request.get("seq"),
            "command": "startDebugging",
            "success": True
        }
        await self.send_dap_message(response)

        # Create a child connection
        child_reader, child_writer = await asyncio.open_connection("127.0.0.1", DAP_PORT)
        child_conn = DapConnection("CHILD", child_reader, child_writer)
        _ = asyncio.create_task(child_conn.read_loop())

        # Initialize the child connection
        init_seq = child_conn.next_sequence()
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
        await child_conn.send_dap_message(init_req)
        init_resp = await child_conn.wait_for_response(init_seq)
        print(f"[CHILD] Received initialize response: {init_resp}")

        # Attach to the target
        launch_seq = child_conn.next_sequence()
        launch_req = {
            "seq": launch_seq,
            "type": "request",
            "command": "attach",
            "arguments": {
                "program": TARGET_SCRIPT,
                "args": [],
                "cwd": os.path.dirname(TARGET_SCRIPT),
                "stopOnEntry": False,
                "type": "pwa-node",
                "__pendingTargetId": target_id
            }
        }
        await child_conn.send_dap_message(launch_req)

        # Wait for the "initialized" event sent by the adapter
        _ = await child_conn.wait_for_event("initialized")
        print("[CHILD] Initialization complete")

        # Set breakpoints
        bp_seq = child_conn.next_sequence()
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
        await child_conn.send_dap_message(set_bp_req)
        bp_resp = await child_conn.wait_for_response(bp_seq)
        print(f"[CHILD] Breakpoints response: {bp_resp}")

        # Send configurationDone
        conf_seq = child_conn.next_sequence()
        conf_req = {
            "seq": conf_seq,
            "type": "request",
            "command": "configurationDone",
            "arguments": {}
        }
        await child_conn.send_dap_message(conf_req)
        conf_resp = await child_conn.wait_for_response(conf_seq)
        print(f"[CHILD] ConfigurationDone response: {conf_resp}")

        # Wait for the "stopped" event
        print("[CHILD] Waiting for the target to hit the breakpoint (stopped event)...")
        stopped_event = await child_conn.wait_for_event("stopped", timeout=15)
        print(f"[CHILD] Received stopped event: {stopped_event}")
        thread_id = stopped_event.get("body", {}).get("threadId", 1)

        # Request a stack trace
        st_seq = child_conn.next_sequence()
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
        await child_conn.send_dap_message(st_req)
        st_resp = await child_conn.wait_for_response(st_seq)
        print(f"[CHILD] StackTrace response: {st_resp}")
        frames = st_resp.get("body", {}).get("stackFrames", [])
        frame_id = frames[0].get("id") if frames else None
        print(f"[CHILD] Using frameId: {frame_id}")

        # Evaluate request for "nextVal"
        eval_seq = child_conn.next_sequence()
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
        await child_conn.send_dap_message(eval_req)
        eval_resp = await child_conn.wait_for_response(eval_seq)
        print(f"[CHILD] Evaluate response: {eval_resp}")
        result_value = eval_resp.get("body", {}).get("result")
        print(f"[CHILD] Value of next_val at breakpoint: {result_value}")

        # Continue execution
        cont_seq = child_conn.next_sequence()
        cont_req = {
            "seq": cont_seq,
            "type": "request",
            "command": "continue",
            "arguments": {"threadId": thread_id}
        }
        await child_conn.send_dap_message(cont_req)
        cont_resp = await child_conn.wait_for_response(cont_seq)
        print(f"[CHILD] Continue response: {cont_resp}")

        # Loop to send continue requests until no stopped event remains
        while True:
            try:
                _ = await child_conn.wait_for_event("stopped", timeout=1)
                print("[CHILD] Extra stopped event received; sending another continue.")
                cont_seq = child_conn.next_sequence()
                cont_req = {
                    "seq": cont_seq,
                    "type": "request",
                    "command": "continue",
                    "arguments": {"threadId": thread_id}
                }
                await child_conn.send_dap_message(cont_req)
                extra_cont = await child_conn.wait_for_response(cont_seq)
                print(f"[CHILD] Extra continue response: {extra_cont}")
            except TimeoutError:
                break

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
    proc = await asyncio.create_subprocess_exec(
        "node", DAP_SERVER_PATH, str(DAP_PORT), "0.0.0.0",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT
    )
    output_task = asyncio.create_task(read_subprocess_output(proc, output_buffer))

    # Wait a moment for the server to start
    await asyncio.sleep(2)

    # Connect to DAP server
    reader, writer = await asyncio.open_connection("127.0.0.1", DAP_PORT)
    print("Connected to DAP server")

    # Create parent connection and start read loop
    parent_conn = DapConnection("PARENT", reader, writer)
    _ = asyncio.create_task(parent_conn.read_loop())

    # Send initialize
    init_seq = parent_conn.next_sequence()
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
    await parent_conn.send_dap_message(init_req)
    init_resp = await parent_conn.wait_for_response(init_seq)
    print("Received initialize response:", init_resp)

    # Send launch
    launch_seq = parent_conn.next_sequence()
    launch_req = {
        "seq": launch_seq,
        "type": "request",
        "command": "launch",
        "arguments": {
            "program": TARGET_SCRIPT,
            "args": [],
            "cwd": os.path.dirname(TARGET_SCRIPT),
            "stopOnEntry": False,
            "type": "pwa-node"
        }
    }
    await parent_conn.send_dap_message(launch_req)
    await asyncio.sleep(0.2)

    # Wait for the "initialized" event
    _ = await parent_conn.wait_for_event("initialized")
    print("Initialization complete")

    # # Set breakpoints
    # bp_seq = parent_conn.next_sequence()
    # set_bp_req = {
    #     "seq": bp_seq,
    #     "type": "request",
    #     "command": "setBreakpoints",
    #     "arguments": {
    #         "source": {
    #             "path": TARGET_SCRIPT,
    #             "name": os.path.basename(TARGET_SCRIPT)
    #         },
    #         "breakpoints": [
    #             {"line": 15}
    #         ],
    #         "sourceModified": False
    #     }
    # }
    # await parent_conn.send_dap_message(set_bp_req)
    # bp_resp = await parent_conn.wait_for_response(bp_seq)
    # print("Breakpoints response:", bp_resp)
    # if not bp_resp.get("success"):
    #     print("Error setting breakpoints:", bp_resp.get("message"))

    # Send configurationDone
    conf_seq = parent_conn.next_sequence()
    conf_req = {
        "seq": conf_seq,
        "type": "request",
        "command": "configurationDone",
        "arguments": {}
    }
    await parent_conn.send_dap_message(conf_req)
    conf_resp = await parent_conn.wait_for_response(conf_seq)
    print("ConfigurationDone response:", conf_resp)

    # Wait for the "stopped" event
    print("Waiting for the target to hit the breakpoint (stopped event)...")
    stopped_event = await parent_conn.wait_for_event("stopped", timeout=15)
    print("Received stopped event:", stopped_event)
    thread_id = stopped_event.get("body", {}).get("threadId", 0)

    # Now, wait for the target process to terminate.
    # await proc.wait()  # You could add a longer timeout here, if needed.
    print("Target process terminated.")

    writer.close()
    await writer.wait_closed()

    # Wait for the output task to complete
    await output_task
    print("\n----- Captured Target Output -----")
    for line in output_buffer:
        print(line)

def main():
    asyncio.run(main_async())

if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        print("Error during dap test:", ex)
        sys.exit(1)