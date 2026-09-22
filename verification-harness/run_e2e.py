import json
import os
import subprocess
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright

results = []
LOG_PATH = "/tmp/e2e_result_log.txt"
_log_file = open(LOG_PATH, "w")


def log(line):
    _log_file.write(line + "\n")
    _log_file.flush()
    os.fsync(_log_file.fileno())
    print(line, flush=True)


def wait_for_server(url, timeout_s=10):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except Exception:
            time.sleep(0.2)
    return False


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append((label, bool(condition)))
    log(f"{status} - {label}" + (f" ({detail})" if detail else ""))


def main():
    harness = subprocess.Popen(
        ["node", "server.mjs"],
        env={"PORT": "4100", "PATH": __import__("os").environ["PATH"]},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        if not wait_for_server("http://localhost:4100/e2e-page.html"):
            log("Harness server did not come up in time.")
            log(harness.stdout.read())
            sys.exit(1)
        _run_scenario()
    finally:
        harness.terminate()
        try:
            harness.wait(timeout=5)
        except subprocess.TimeoutExpired:
            harness.kill()


def _run_scenario():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        alice = browser.new_page()
        bob = browser.new_page()
        alice.goto("http://localhost:4100/e2e-page.html")
        bob.goto("http://localhost:4100/e2e-page.html")
        alice.wait_for_function("window.__ready === true")
        bob.wait_for_function("window.__ready === true")

        # --- Registration ---
        alice_reg = alice.evaluate(
            "([pw, name]) => window.register(pw, name)", ["alice-password-123", "Alice Laptop"]
        )
        bob_reg = bob.evaluate("([pw, name]) => window.register(pw, name)", ["bob-password-456", "Bob Phone"])
        check("Alice registered with a real user/device id", alice_reg["userId"] and alice_reg["deviceId"])
        check("Bob registered with a real user/device id", bob_reg["userId"] and bob_reg["deviceId"])
        check("Alice and Bob got different user ids", alice_reg["userId"] != bob_reg["userId"])

        # --- Pairing ---
        pairing = alice.evaluate("(sec) => window.createPairingCode(sec)", 900)
        code = pairing["code"]
        check("Pairing code is 6 digits", len(code) == 6 and code.isdigit(), code)

        wrong_code = "111111" if code != "111111" else "222222"
        bad = bob.evaluate(
            """(code) => window.redeemPairingCode(code).then(() => 'no error').catch(e => e.message)""",
            wrong_code,
        )
        check("Wrong pairing code is rejected", "400" in bad, bad)

        redeemed = bob.evaluate("(code) => window.redeemPairingCode(code)", code)
        check("Correct pairing code succeeds and returns a conversation", bool(redeemed.get("conversationId")))
        conv_id = redeemed["conversationId"]

        re_redeem = alice.evaluate(
            """(code) => window.redeemPairingCode(code).then(() => 'no error').catch(e => e.message)""",
            code,
        )
        check("A used pairing code cannot be redeemed a second time", "400" in re_redeem, re_redeem)

        # --- X3DH handshake completion (asynchronous, on Alice's side) ---
        alice.evaluate("(cid) => window.completeHandshakeFromServer(cid)", conv_id)
        check("Alice completed her side of the handshake without error", True)

        # --- Offline delivery ---
        msg1 = bob.evaluate("([cid, t]) => window.sendMessage(cid, t)", [conv_id, "Hey Alice, are you around?"])
        msg2 = bob.evaluate("([cid, t]) => window.sendMessage(cid, t)", [conv_id, "Sent this while you were offline"])
        check("Bob sent 2 messages while Alice was offline", msg1["sequenceNumber"] == 1 and msg2["sequenceNumber"] == 2)
        check(
            "Neither message was marked delivered yet (Alice not connected)",
            msg1["delivered"] is False and msg2["delivered"] is False,
        )

        # --- Alice reconnects and syncs ---
        alice.evaluate("() => window.connectWs()")
        synced = alice.evaluate("(cid) => window.syncMessages(cid, 0)", conv_id)
        check("Alice synced exactly 2 messages after reconnecting", len(synced) == 2, str(len(synced)))
        plaintexts = [m["plaintext"] for m in synced]
        check(
            "Both offline messages decrypted correctly, in order",
            plaintexts == ["Hey Alice, are you around?", "Sent this while you were offline"],
            json.dumps(plaintexts),
        )

        # --- Read receipts over WS ---
        bob.evaluate("() => window.connectWs()")
        bob.evaluate("() => window.clearEvents()")
        alice.evaluate("(id) => window.markRead(id)", synced[0]["id"])
        time.sleep(0.3)
        bob_events = bob.evaluate("() => window.getEvents()")
        check(
            "Bob received a live read-receipt over WebSocket",
            any(e.get("type") == "read_receipt" and e.get("messageId") == synced[0]["id"] for e in bob_events),
            json.dumps(bob_events),
        )

        # --- Live delivery while both connected ---
        alice.evaluate("() => window.clearEvents()")
        bob.evaluate("() => window.clearEvents()")
        reply = alice.evaluate("([cid, t]) => window.sendMessage(cid, t)", [conv_id, "Yes, I am here now!"])
        check("Alice's reply was marked delivered immediately (Bob is connected)", reply["delivered"] is True)
        time.sleep(0.3)
        bob_live_events = bob.evaluate("() => window.getEvents()")
        live_msg = next((e for e in bob_live_events if e.get("type") == "message"), None)
        check("Bob received the reply live over WebSocket (no polling needed)", live_msg is not None)
        if live_msg:
            decrypted = bob.evaluate(
                "([cid, evt]) => window.decryptLiveEvent(cid, evt)", [conv_id, live_msg]
            )
            check("The live-delivered message decrypts correctly", decrypted == "Yes, I am here now!", decrypted)

        # --- Typing indicator ---
        bob.evaluate("() => window.clearEvents()")
        alice.evaluate("(cid) => window.sendTyping(cid, true)", conv_id)
        time.sleep(0.3)
        typing_events = bob.evaluate("() => window.getEvents()")
        check(
            "Bob received Alice's typing event live",
            any(e.get("type") == "typing" and e.get("isTyping") is True for e in typing_events),
            json.dumps(typing_events),
        )

        # --- Tamper detection over the real session state ---
        tamper_result = bob.evaluate(
            """(cid) => {
                const aad = window.Engine.buildAad(cid, window.state.recvStep);
                return window.Engine.ratchetDecrypt(
                    window.state.session.receivingChainKey,
                    { ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', iv: 'AAAAAAAAAAAAAAAAAAAAAAAA' },
                    aad
                ).then(() => 'did not throw').catch(() => 'threw');
            }""",
            conv_id,
        )
        check("Tampered/garbage ciphertext is rejected, not silently decrypted", tamper_result == "threw")

        # --- Blocking enforced server-side ---
        bob.evaluate("(cid) => window.blockConversation(cid)", conv_id)
        blocked_error = alice.evaluate(
            "([cid, t]) => window.sendMessageExpectError(cid, t)", [conv_id, "can you still see this?"]
        )
        check(
            "After Bob blocks, the server itself rejects Alice's send (not just hidden client-side)",
            blocked_error is not None and "403" in blocked_error,
            str(blocked_error),
        )

        browser.close()

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    log(f"\n{passed}/{total} checks passed.")
    if passed != total:
        failed = [label for label, ok in results if not ok]
        log(f"FAILED: {failed}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
