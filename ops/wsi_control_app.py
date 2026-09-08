#!/usr/bin/env python3
"""Standalone WSI Control app for macOS and Windows 11.

Buttons call ops/wsi_service_control.py locally, or the ops dashboard JSON
API when remote mode is configured. If Tk is missing, a numbered text menu
is used.
"""
from __future__ import annotations

import os
import sys
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import wsi_service_control as control  # noqa: E402

LIVE = {"password": ""}


def active_config():
    cfg = control.load_control_config()
    if LIVE.get("password"):
        cfg["password"] = LIVE["password"]
    return cfg


def snapshot_text():
    try:
        data = control.dispatch_action("both", "status", cfg=active_config())
        prefix = remote_banner()
        return (prefix + "\n" if prefix else "") + control.format_status(data)
    except control.ServiceError as error:
        prefix = remote_banner()
        return (prefix + "\n" if prefix else "") + str(error)


def remote_banner():
    url = (active_config().get("remote_url") or "").strip()
    if not url:
        return "Mode: this computer"
    return f"Mode: remote {url}"


def run_and_report(target, action):
    try:
        result = control.dispatch_action(target, action, cfg=active_config())
        return control.format_status(result)
    except control.ServiceError as error:
        return str(error)


def run_text_menu():
    actions = [
        ("1", "Launch image server", "viewer", "start"),
        ("2", "Quit image server", "viewer", "stop"),
        ("3", "Relaunch image server", "viewer", "relaunch"),
        ("4", "Launch ingestion engine", "ingest", "start"),
        ("5", "Quit ingestion engine", "ingest", "stop"),
        ("6", "Relaunch ingestion engine", "ingest", "relaunch"),
        ("7", "Launch both", "both", "start"),
        ("8", "Quit both", "both", "stop"),
        ("9", "Relaunch both", "both", "relaunch"),
        ("s", "Refresh status", None, None),
        ("w", "Open web services page", None, "web"),
        ("v", "Open viewer", None, "viewer"),
        ("q", "Quit this app", None, "quit"),
    ]
    print("WSI Control")
    print(snapshot_text())
    print()
    print("Remote mode uses WSI_CONTROL_REMOTE / WSI_CONTROL_TOKEN, or the saved config file.")
    print()
    while True:
        for key, label, _target, _action in actions:
            print(f"  {key}) {label}")
        choice = input("> ").strip().lower()
        if choice in {"q", "quit"}:
            return 0
        if choice in {"s", ""}:
            print(snapshot_text())
            continue
        if choice == "w":
            webbrowser.open(control.dashboard_page_url(active_config()))
            continue
        if choice == "v":
            webbrowser.open(control.viewer_open_url(active_config()))
            continue
        match = next((item for item in actions if item[0] == choice), None)
        if not match:
            print("Unknown choice.")
            continue
        print(run_and_report(match[2], match[3]))
        print(snapshot_text())


def run_gui():
    import tkinter as tk
    from tkinter import messagebox, ttk

    root = tk.Tk()
    root.title("WSI Control")
    root.minsize(520, 620)
    stored = control.load_control_config()
    status = tk.StringVar(value=snapshot_text())
    mode = tk.StringVar(value="remote" if (stored.get("remote_url") or "").strip() else "local")
    remote_url = tk.StringVar(value=stored.get("remote_url") or "")
    token = tk.StringVar(value=stored.get("token") or "")
    password = tk.StringVar(value="")
    save_note = tk.StringVar(value="")

    def current_cfg():
        cfg = control.load_control_config()
        if mode.get() == "local":
            cfg["remote_url"] = ""
        else:
            cfg["remote_url"] = remote_url.get().strip()
            cfg["token"] = token.get().strip()
        LIVE["password"] = password.get()
        if LIVE["password"]:
            cfg["password"] = LIVE["password"]
        return cfg

    def live_snapshot():
        try:
            data = control.dispatch_action("both", "status", cfg=current_cfg())
            url = (current_cfg().get("remote_url") or "").strip()
            prefix = "Mode: this computer" if not url else f"Mode: remote {url}"
            return prefix + "\n" + control.format_status(data)
        except control.ServiceError as error:
            url = (current_cfg().get("remote_url") or "").strip()
            prefix = "Mode: this computer" if not url else f"Mode: remote {url}"
            return prefix + "\n" + str(error)

    def refresh():
        status.set(live_snapshot())
        root.after(4000, refresh)

    def act(target, action):
        try:
            result = control.dispatch_action(target, action, cfg=current_cfg())
            status.set(control.format_status(result) + "\n\n" + live_snapshot())
        except control.ServiceError as error:
            messagebox.showerror("WSI Control", str(error))
            status.set(str(error) + "\n\n" + live_snapshot())

    def save_settings():
        cfg = {
            "remote_url": remote_url.get().strip() if mode.get() == "remote" else "",
            "token": token.get().strip(),
            "viewer_url": "",
        }
        if cfg["remote_url"]:
            try:
                cfg["remote_url"] = control.normalize_remote_url(cfg["remote_url"])
                remote_url.set(cfg["remote_url"])
            except control.ServiceError as error:
                messagebox.showerror("WSI Control", str(error))
                return
        path = control.save_control_config(cfg)
        LIVE["password"] = password.get()
        save_note.set(f"Saved {path}")
        status.set(live_snapshot())

    pad = {"padx": 10, "pady": 6}
    ttk.Label(root, text="Image server and ingestion engine", font=("TkDefaultFont", 14, "bold")).pack(anchor="w", **pad)
    ttk.Label(root, textvariable=status, justify="left").pack(anchor="w", fill="x", **pad)

    settings = ttk.LabelFrame(root, text="Where to control")
    settings.pack(fill="x", padx=10, pady=6)
    ttk.Radiobutton(settings, text="This computer", variable=mode, value="local").pack(anchor="w", padx=8, pady=2)
    ttk.Radiobutton(settings, text="Another computer (ops dashboard)", variable=mode, value="remote").pack(anchor="w", padx=8, pady=2)
    ttk.Label(settings, text="Dashboard URL").pack(anchor="w", padx=8)
    ttk.Entry(settings, textvariable=remote_url, width=56).pack(fill="x", padx=8, pady=2)
    ttk.Label(settings, text="Control token (preferred)").pack(anchor="w", padx=8)
    ttk.Entry(settings, textvariable=token, width=56, show="*").pack(fill="x", padx=8, pady=2)
    ttk.Label(settings, text="Dashboard password (used if there is no token; not saved)").pack(anchor="w", padx=8)
    ttk.Entry(settings, textvariable=password, width=56, show="*").pack(fill="x", padx=8, pady=2)
    ttk.Button(settings, text="Save connection settings", command=save_settings).pack(anchor="w", padx=8, pady=6)
    ttk.Label(settings, textvariable=save_note).pack(anchor="w", padx=8, pady=(0, 6))

    def row(parent, title, target):
        frame = ttk.LabelFrame(parent, text=title)
        frame.pack(fill="x", padx=10, pady=6)
        ttk.Button(frame, text="Launch", command=lambda: act(target, "start")).pack(side="left", padx=6, pady=8)
        ttk.Button(frame, text="Quit", command=lambda: act(target, "stop")).pack(side="left", padx=6, pady=8)
        ttk.Button(frame, text="Relaunch", command=lambda: act(target, "relaunch")).pack(side="left", padx=6, pady=8)

    row(root, "Image server (viewer)", "viewer")
    row(root, "Ingestion engine", "ingest")
    row(root, "Both (one step)", "both")

    links = ttk.Frame(root)
    links.pack(fill="x", padx=10, pady=10)
    ttk.Button(links, text="Refresh status", command=lambda: status.set(live_snapshot())).pack(side="left", padx=4)
    ttk.Button(links, text="Open web page", command=lambda: webbrowser.open(control.dashboard_page_url(current_cfg()))).pack(side="left", padx=4)
    ttk.Button(links, text="Open viewer", command=lambda: webbrowser.open(control.viewer_open_url(current_cfg()))).pack(side="left", padx=4)

    root.after(4000, refresh)
    root.mainloop()
    return 0


def main():
    if "--cli" in sys.argv:
        return run_text_menu()
    try:
        import tkinter  # noqa: F401
    except ImportError:
        print("Tk is not available; using the text menu.")
        return run_text_menu()
    return run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
