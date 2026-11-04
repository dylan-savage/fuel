import { expect, test } from '@playwright/test';

test('looks for a new build when the app comes back to the front', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('update-checks', '0');
    ServiceWorkerRegistration.prototype.update = new Proxy(ServiceWorkerRegistration.prototype.update, {
      apply(update, registration, args) {
        localStorage.setItem('update-checks', String(Number(localStorage.getItem('update-checks')) + 1));
        return Reflect.apply(update, registration, args);
      },
    });
  });
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  const checks = () => page.evaluate(() => Number(localStorage.getItem('update-checks')));

  await expect
    .poll(async () => {
      const before = await checks();
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      return (await checks()) - before;
    })
    .toBeGreaterThan(0);
});
