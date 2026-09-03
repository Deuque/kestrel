"""
Pytest plugin kestrel injects into the test process via PYTHONPATH.

This is what lets a calling repo have *only* raw test files — no
conftest.py, no AppiumService setup of its own. It provides:

  - a `driver` fixture: an Appium session already connected to the server
    kestrel started and pointed at the APK kestrel installed.
  - automatic screenshot capture after every test — pass or fail — saved
    under KESTREL_SCREENSHOTS_DIR using the test's own node id as the
    filename, so kestrel's report can match a screenshot to its result
    exactly (no filename-guessing needed) and a passing test's screenshot
    is visible proof it actually ran, not just a green checkmark.
  - on failure only: also dumps the accessibility page source (the actual
    element tree UiAutomator2 saw) next to the screenshot as a .xml file —
    kestrel's report doesn't surface it, but it's in the same results
    artifact, and it's the fastest way to confirm what a locator should
    have matched instead of guessing from a screenshot alone.
  - every test also gets its own device log (`adb logcat`, cleared right
    before the session starts so it's scoped to just that test) saved as
    a .log file next to the screenshot. This is how you find out whether
    a test failed because of the app (a network call that actually
    failed, a stack trace) rather than the test — a "waiting for the next
    screen" timeout looks identical from the UI alone whether the
    request never returned or came back a 401.

kestrel runs testCommand with these env vars already set:
  KESTREL_APPIUM_SERVER_URL   e.g. http://localhost:4723
  KESTREL_APK_PATH            absolute path to the APK under test
  KESTREL_SCREENSHOTS_DIR     where to drop a screenshot on failure
  KESTREL_PLATFORM_NAME       default "Android"
  KESTREL_DEVICE_NAME         default "Android Emulator"
  KESTREL_AUTOMATION_NAME     default "UiAutomator2"

A test repo just needs pytest + Appium-Python-Client installed and to run
pytest with `-p kestrel_appium_plugin` (kestrel's example configs already do
this) — then write tests like:

    def test_login_with_valid_credentials(driver):
        driver.find_element(...).click()
        ...

Also provides `step()`, a context manager for narrating what a test is
doing so a failure says what broke instead of just how: wrap each
meaningful action in `with step("fill in email"): ...` and a failure
inside it becomes "Step failed: fill in email" followed by a short,
stacktrace-free error — that's what ends up in kestrel's report instead of
a bare Selenium exception dump.

    from kestrel_appium_plugin import step

    def test_login_with_valid_credentials(driver):
        with step("open the login form"):
            driver.find_element(...).click()
"""
import os
import re
import subprocess
from contextlib import contextmanager

import pytest
from appium import webdriver
from appium.options.android import UiAutomator2Options


def _capabilities() -> UiAutomator2Options:
    options = UiAutomator2Options()
    options.platform_name = os.environ.get("KESTREL_PLATFORM_NAME", "Android")
    options.automation_name = os.environ.get("KESTREL_AUTOMATION_NAME", "UiAutomator2")
    options.device_name = os.environ.get("KESTREL_DEVICE_NAME", "Android Emulator")
    options.app = os.environ["KESTREL_APK_PATH"]
    return options


def _clear_device_log() -> None:
    try:
        subprocess.run(["adb", "logcat", "-c"], check=False, timeout=10)
    except Exception:
        pass


@pytest.fixture
def driver():
    server_url = os.environ["KESTREL_APPIUM_SERVER_URL"]
    _clear_device_log()
    session = webdriver.Remote(server_url, options=_capabilities())
    yield session
    session.quit()


def _slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()


@contextmanager
def step(description: str):
    """Narrates one action; a failure inside says which step broke, with a
    short error instead of a raw exception dump (Selenium's __str__ embeds
    its own multi-line "Stacktrace: ..." block, which .msg — the message
    alone — doesn't have)."""
    try:
        yield
    except Exception as e:
        short = getattr(e, "msg", None) or str(e).split("\n")[0]
        raise AssertionError(f"Step failed: {description}\n{type(e).__name__}: {short}") from e


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()

    if report.when != "call":
        return

    driver = item.funcargs.get("driver")
    screenshots_dir = os.environ.get("KESTREL_SCREENSHOTS_DIR")
    if driver is None or not screenshots_dir:
        return

    os.makedirs(screenshots_dir, exist_ok=True)
    base = os.path.join(screenshots_dir, _slug(item.nodeid))
    try:
        driver.get_screenshot_as_file(f"{base}.png")
    except Exception:
        pass

    if report.failed:
        try:
            with open(f"{base}.xml", "w") as f:
                f.write(driver.page_source)
        except Exception:
            pass

    try:
        result = subprocess.run(
            ["adb", "logcat", "-d"], capture_output=True, text=True, timeout=15, check=False
        )
        with open(f"{base}.log", "w") as f:
            f.write(result.stdout)
    except Exception:
        pass
