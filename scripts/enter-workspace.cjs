module.exports = async function enterWorkspace(page) {
  await page.locator('#presenceKnot:enabled').waitFor();
  await page.locator('#toggleSidebar').click();
  await page.locator('#enterWorkspace').click();
  await page.locator('#presence').waitFor({ state: 'hidden' });
};
