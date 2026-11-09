"""A minimal Marionette client — Firefox's built-in remote protocol.

No dependencies, no geckodriver, no npm. Firefox is started with
`--marionette`, which opens a socket on 127.0.0.1:2828, and this module
speaks the packet protocol directly.

Packets are framed as `<byte-length>:<json>`, where the JSON is
`[type, messageId, command, params]`:

    type 0  command
    type 1  response

Usage:

    from marionette import Marionette

    with Marionette() as firefox:
        firefox.navigate("http://127.0.0.1:8792/")
        firefox.execute_script("return document.title")
        firefox.screenshot("/tmp/shot.png")
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

MARIONETTE_PORT = 2828


class MarionetteError(RuntimeError):
    pass


class Marionette:
    def __init__(self, binary: str = "firefox", port: int = MARIONETTE_PORT, headless: bool = True):
        self.binary = binary
        self.port = port
        self.headless = headless
        self.process: subprocess.Popen | None = None
        self.socket: socket.socket | None = None
        self.message_id = 0
        self.profile_dir: str | None = None
        self.download_dir: str | None = None

    # --- lifecycle ---------------------------------------------------------

    def start(self, timeout: float = 40.0, download_dir: str | None = None) -> None:
        self.profile_dir = tempfile.mkdtemp(prefix="vp-firefox-")
        prefs = Path(self.profile_dir) / "user.js"
        download_prefs = []
        if download_dir:
            Path(download_dir).mkdir(parents=True, exist_ok=True)
            download_prefs = [
                'user_pref("browser.download.folderList", 2);',
                f'user_pref("browser.download.dir", "{download_dir}");',
                'user_pref("browser.download.useDownloadDir", true);',
                'user_pref("browser.download.manager.showWhenStarting", false);',
                'user_pref("browser.helperApps.neverAsk.saveToDisk", '
                '"application/json,image/png,application/octet-stream,text/plain");',
                'user_pref("browser.download.always_ask_before_handling_new_types", false);',
            ]
        prefs.write_text(
            "\n".join(
                [
                    # No first-run wizard, no update checks, no telemetry.
                    'user_pref("browser.shell.checkDefaultBrowser", false);',
                    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
                    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
                    'user_pref("datareporting.healthreport.uploadEnabled", false);',
                    'user_pref("toolkit.telemetry.enabled", false);',
                    'user_pref("app.update.enabled", false);',
                    'user_pref("extensions.autoDisableScopes", 15);',
                    'user_pref("browser.aboutwelcome.enabled", false);',
                    # Never ask about the clipboard or notifications.
                    'user_pref("dom.events.testing.asyncClipboard", true);',
                    'user_pref("dom.events.testing.asyncClipboard.readText", true);',
                    'user_pref("dom.events.testing.asyncClipboard.writeText", true);',
                    'user_pref("dom.events.testing.asyncClipboard.get", true);',
                    'user_pref("dom.events.testing.asyncClipboard.set", true);',
                    # Keep the profile offline: this app must never touch the
                    # network, and a stray request would be a real failure.
                    'user_pref("network.dns.disabled", true);',
                    'user_pref("browser.safebrowsing.malware.enabled", false);',
                    'user_pref("browser.safebrowsing.phishing.enabled", false);',
                    'user_pref("captivedetect.canonicalURL", "");',
                    'user_pref("network.captive-portal-service.enabled", false);',
                    'user_pref("browser.region.network.url", "");',
                    'user_pref("browser.safebrowsing.downloads.enabled", false);',
                    'user_pref("browser.contentblocking.report.lockwise.enabled", false);',
                    'user_pref("network.prefetch-next", false);',
                    *download_prefs,
                ]
            ),
            encoding="utf-8",
        )

        command = [
            self.binary,
            "--marionette",
            "--no-remote",
            "--profile",
            self.profile_dir,
            "about:blank",
        ]
        if self.headless:
            command.insert(1, "--headless")

        self.process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**os.environ, "MOZ_MARIONETTE_PORT": str(self.port)},
        )

        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.socket = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                break
            except OSError:
                if self.process.poll() is not None:
                    raise MarionetteError("firefox exited before marionette opened")
                time.sleep(0.25)
        else:
            raise MarionetteError("timed out waiting for marionette")

        self.socket.settimeout(120)
        self._read_packet()  # the handshake
        self.send("WebDriver:NewSession", {"capabilities": {}})

    def stop(self) -> None:
        if self.socket:
            try:
                self.socket.close()
            except OSError:
                pass
            self.socket = None
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None
        if self.profile_dir:
            shutil.rmtree(self.profile_dir, ignore_errors=True)
            self.profile_dir = None

    def __enter__(self) -> "Marionette":
        self.start(download_dir=self.download_dir)
        return self

    def __exit__(self, *exc) -> None:
        self.stop()

    # --- the wire -----------------------------------------------------------

    def _read_packet(self):
        header = b""
        while b":" not in header:
            chunk = self.socket.recv(1)
            if not chunk:
                raise MarionetteError("the connection closed")
            header += chunk
        length = int(header[:-1])
        body = b""
        while len(body) < length:
            chunk = self.socket.recv(length - len(body))
            if not chunk:
                raise MarionetteError("the connection closed mid-packet")
            body += chunk
        return json.loads(body.decode("utf-8"))

    def _write_packet(self, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.socket.sendall(str(len(body)).encode("ascii") + b":" + body)

    def send(self, command: str, params: dict | None = None):
        self.message_id += 1
        message_id = self.message_id
        self._write_packet([0, message_id, command, params or {}])

        while True:
            packet = self._read_packet()
            if not isinstance(packet, list) or len(packet) < 4:
                continue
            kind, reply_id, reply_command, reply_params = packet[0], packet[1], packet[2], packet[3]
            if kind != 1 or reply_id != message_id:
                continue
            # An error arrives with the error object in the command slot.
            if isinstance(reply_command, dict) and "error" in reply_command:
                error = reply_command
                raise MarionetteError(
                    f"{error.get('error')}: {error.get('message')} "
                    f"({error.get('stacktrace', '')})"
                )
            if reply_command == "error":
                error = reply_params or {}
                raise MarionetteError(
                    f"{error.get('error')}: {error.get('message')} "
                    f"({error.get('stacktrace', '')})"
                )
            return reply_params

    # --- the commands we use -------------------------------------------------

    def navigate(self, url: str) -> None:
        self.send("WebDriver:Navigate", {"url": url})

    def execute_script(self, script: str, args: list | None = None):
        result = self.send(
            "WebDriver:ExecuteScript", {"script": script, "args": args or [], "newSandbox": False}
        )
        return result.get("value")

    def execute_async_script(self, script: str, args: list | None = None):
        result = self.send(
            "WebDriver:ExecuteAsyncScript",
            {"script": script, "args": args or [], "newSandbox": False},
        )
        return result.get("value")

    def screenshot(self, path: str, full: bool = False) -> str:
        result = self.send("WebDriver:TakeScreenshot", {"full": full, "hash": False})
        data = result.get("value")
        Path(path).write_bytes(base64.b64decode(data))
        return path

    def set_window_rect(self, width: int, height: int) -> None:
        self.send(
            "WebDriver:SetWindowRect",
            {"x": 0, "y": 0, "width": width, "height": height},
        )

    def find_element(self, selector: str):
        result = self.send(
            "WebDriver:FindElement", {"using": "css selector", "value": selector}
        )
        return (result.get("value") or {}).get("element-6066-11e4-a52e-4f735466cecf")

    def click(self, selector: str) -> None:
        element = self.find_element(selector)
        if not element:
            raise MarionetteError(f"no element for {selector}")
        self.send("WebDriver:ElementClick", {"id": element})

    def send_keys_to(self, selector: str, text: str) -> None:
        element = self.find_element(selector)
        if not element:
            raise MarionetteError(f"no element for {selector}")
        self.send(
            "WebDriver:ElementSendKeys",
            {"id": element, "text": text, "value": list(text)},
        )

    def set_file_input(self, selector: str, path: str) -> None:
        """Points a file input at a local file — the browser reads it locally,
        exactly as a user picking a file would."""
        element = self.find_element(selector)
        if not element:
            raise MarionetteError(f"no element for {selector}")
        self.send(
            "WebDriver:ElementSendKeys",
            {"id": element, "text": path, "value": [path]},
        )

    def perform_actions(self, actions: list) -> None:
        self.send("WebDriver:PerformActions", {"actions": actions})

    def release_actions(self) -> None:
        self.send("WebDriver:ReleaseActions", {})
