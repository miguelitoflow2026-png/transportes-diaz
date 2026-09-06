import { test, expect } from '@playwright/test';

test.describe('Smoke — 3 flujos críticos', () => {
  test('login por rol (conductor)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Conductor/i }).click();
    await page.locator('#loginEmail').fill('conductor@transportesdiaz.cl');
    await page.locator('#loginPass').fill('NVbmh9C4gjwa');
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();
    await expect(page.getByText(/Hola,/i)).toBeVisible({ timeout: 10000 });
  });

  test('login por rol (admin)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Admin/i }).click();
    await page.locator('#loginEmail').fill('miguelitoflow2026@gmail.com');
    await page.locator('#loginPass').fill('kckQm9kuZENX');
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();
    await expect(page.getByText(/Backoffice Admin/i)).toBeVisible({ timeout: 10000 });
  });

  test('ciclo viaje: inicio → espera → finalizar (sin GPS real)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Conductor/i }).click();
    await page.locator('#loginEmail').fill('conductor@transportesdiaz.cl');
    await page.locator('#loginPass').fill('NVbmh9C4gjwa');
    await page.getByRole('button', { name: /Iniciar sesión/i }).click();
    await expect(page.getByText(/Hola,/i)).toBeVisible();

    // Iniciar viaje (si no hay activo)
    const iniciarBtn = page.getByRole('button', { name: /Iniciar viaje/i });
    if (await iniciarBtn.isVisible()) {
      await iniciarBtn.click();
      // Seleccionar primer contrato/ceco/vehículo si aparecen
      const selContrato = page.locator('#selContrato');
      if (await selContrato.isVisible({ timeout: 2000 }).catch(() => false)) {
        await selContrato.selectOption({ index: 1 });
        await page.waitForTimeout(300);
        const selCeco = page.locator('#selCeco');
        if (await selCeco.isEnabled()) await selCeco.selectOption({ index: 1 });
        const selVehiculo = page.locator('#selVehiculo');
        if (await selVehiculo.isVisible()) await selVehiculo.selectOption({ index: 1 });
        await page.getByRole('button', { name: /Continuar/i }).click();
        await page.getByRole('button', { name: /Urbano/i }).first().click();
        await page.getByRole('button', { name: /Continuar.*Puntos/i }).click();
        await page.getByRole('button', { name: /Iniciar sin puntos/i }).click();
      }
      await expect(page.getByText(/En conducción/i)).toBeVisible({ timeout: 5000 });
    }

    // Espera → verifica que KM no se resetea y wait sube (si no hay viaje activo, skip)
    const esperarBtn = page.getByRole('button', { name: /Iniciar espera/i });
    if (await esperarBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      const kmAntes = await page.locator('#km-display').textContent().catch(() => '0.00');
      await esperarBtn.click();
      await expect(page.getByText(/En espera/i)).toBeVisible({ timeout: 5000 });
      await page.waitForTimeout(2100);
      const waitText = await page.locator('#wait-display').textContent();
      expect(waitText).not.toBe('00:00');
      const kmDuranteEspera = await page.locator('#km-display').textContent();
      expect(kmDuranteEspera).toBe(kmAntes);
    }

    // Reanudar
    await page.getByRole('button', { name: /Reanudar/i }).click();
    await expect(page.getByText(/En conducción/i)).toBeVisible();
  });
});
