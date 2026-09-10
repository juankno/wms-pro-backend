import { Injectable, Logger } from '@nestjs/common';

interface PushPayload {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expoUrl = 'https://exp.host/--/api/v2/push/send';

  async send(payload: PushPayload | PushPayload[]) {
    const messages = Array.isArray(payload) ? payload : [payload];
    const valid = messages.filter((m) => m.to?.startsWith('ExponentPushToken'));
    if (!valid.length) return;

    try {
      await fetch(this.expoUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(valid),
      });
    } catch (err) {
      this.logger.error('Push notification failed', err);
    }
  }

  async notifyStockLow(pushTokens: string[], productCode: string, available: number, warehouseId: string) {
    await this.send(
      pushTokens.map((to) => ({
        to,
        title: 'Stock bajo',
        body: `${productCode} tiene ${available} unidades disponibles`,
        data: { type: 'stock_low', productCode, warehouseId },
      })),
    );
  }

  async notifyOrderAssigned(pushToken: string, reference: string, orderType: 'picking' | 'packing') {
    await this.send({
      to: pushToken,
      title: 'Nueva orden asignada',
      body: `Se te asignó ${orderType === 'picking' ? 'el picking' : 'el packing'} ${reference}`,
      data: { type: 'order_assigned', reference, orderType },
    });
  }
}
