import type { NotificationType } from '../../types/database';

export type NotificationModel = {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};
