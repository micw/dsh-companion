/** Validated Webview requests for prompt delivery and DSH-owned queue operations. */

/** One pasted raster encoded for DSH prompt admission. */
export interface UserImageUpload {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly data: string;
  readonly name?: string;
}

export interface SubmitMessage {
  readonly type: 'submit';
  readonly requestId: string;
  readonly text: string;
  readonly mode: 'queue' | 'steer';
  readonly images?: readonly UserImageUpload[];
}

export interface StopMessage {
  readonly type: 'stop';
}

export interface QueueActionMessage {
  readonly type: 'queueAction';
  readonly itemId: string;
  readonly action: 'remove' | 'takeBack' | 'steer';
}

export interface LoadImageMessage {
  readonly type: 'loadImage';
  readonly attachmentId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;

function encodedBytes(data: string): number {
  return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

function imageUpload(value: unknown): value is UserImageUpload {
  if (!record(value) || Object.keys(value).some(key => !['mediaType', 'data', 'name'].includes(key))
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value.mediaType))
    || typeof value.data !== 'string' || value.data.length === 0
    || value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.data)
    || encodedBytes(value.data) > MAX_IMAGE_BYTES
    || (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 255))) return false;
  return true;
}

/** Accept one text-and-image prompt with an explicit DSH delivery mode. */
export function isSubmitMessage(value: unknown): value is SubmitMessage {
  return record(value) && Object.keys(value).every(key => ['type', 'requestId', 'text', 'mode', 'images'].includes(key))
    && value.type === 'submit'
    && typeof value.requestId === 'string' && value.requestId.length > 0
    && typeof value.text === 'string'
    && (value.mode === 'queue' || value.mode === 'steer')
    && (value.images === undefined || Array.isArray(value.images)
      && value.images.length <= 20 && value.images.every(imageUpload)
      && value.images.reduce((bytes, image) => bytes + encodedBytes(image.data), 0)
        <= MAX_MESSAGE_IMAGE_BYTES)
    && (value.text.trim().length > 0 || Array.isArray(value.images) && value.images.length > 0);
}

/** Accept only a session-scoped Stop request without extra payload. */
export function isStopMessage(value: unknown): value is StopMessage {
  return record(value) && Object.keys(value).length === 1 && value.type === 'stop';
}

/** Accept one operation on a DSH Inbox occurrence identity. */
export function isQueueActionMessage(value: unknown): value is QueueActionMessage {
  return record(value) && Object.keys(value).length === 3 && value.type === 'queueAction'
    && typeof value.itemId === 'string' && value.itemId.length > 0 && value.itemId.length <= 256
    && (value.action === 'remove' || value.action === 'takeBack' || value.action === 'steer');
}

/** Accept only a bounded durable image identity from the Webview. */
export function isLoadImageMessage(value: unknown): value is LoadImageMessage {
  return record(value) && Object.keys(value).length === 2 && value.type === 'loadImage'
    && typeof value.attachmentId === 'string' && value.attachmentId.length > 0
    && value.attachmentId.length <= 256;
}
