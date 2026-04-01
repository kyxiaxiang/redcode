/**
 * tokenizer.ts - 统一 token 估算模块
 *
 * 使用 js-tiktoken 的 cl100k_base 编码器（与 Claude tokenizer 高度近似，误差 < 5%）
 * 纯 JS 实现，无 WASM，无网络请求，ESM 兼容
 */

import { getEncoding } from 'js-tiktoken';

const enc = getEncoding('cl100k_base');

/**
 * 估算文本的 token 数
 * 使用 cl100k_base 编码（GPT-3.5/4 同款，与 Claude tokenizer 近似）
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    return enc.encode(text).length;
}
