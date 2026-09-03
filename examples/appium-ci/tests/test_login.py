# Raw test file — no conftest.py, no AppiumService setup. `driver` is
# supplied by kestrel's injected pytest plugin, already connected to the
# Appium server kestrel started and the APK kestrel installed.
from appium.webdriver.common.appiumby import AppiumBy


def test_login_with_valid_credentials(driver):
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "username").send_keys("demo")
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "password").send_keys("correct-horse")
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "login-button").click()
    assert driver.find_element(AppiumBy.ACCESSIBILITY_ID, "home-screen").is_displayed()


def test_login_rejects_bad_password(driver):
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "username").send_keys("demo")
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "password").send_keys("wrong")
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "login-button").click()
    assert driver.find_element(AppiumBy.ACCESSIBILITY_ID, "error-banner").is_displayed()
