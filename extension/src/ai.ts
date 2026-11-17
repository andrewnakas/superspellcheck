// On-device AI deep check: a small fine-tuned Qwen model, run with transformers.js
// on WebGPU (or WASM as a fallback). Lives in an extension document (Chrome offscreen
// document / Firefox background page), never in a web page.
import { AutoModelForCausalLM, AutoTokenizer, env, type PreTrainedModel, type PreTrainedTokenizer } from '@huggingface/transformers';
import PROMPT from '../../train/prompt.json';

export interface AiStatus {
  state: 'off' | 'loading' | 'ready' | 'error';
  progress?: number; // 0..100 while downloading
  device?: 'webgpu' | 'wasm';
  error?: string;
  model?: string;
}

export interface AiLoadOptions {
  model: string;
  /** Override the model host (tests serve a local mirror). Default: Hugging Face. */
  host?: string;
  onStatus?: (s: AiStatus) => void;
}

export function buildPrompt(src: string): string {
  return PROMPT.template.replace('{system}', PROMPT.system).replace('{src}', src);
}

async function pickDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    const gpu = (navigator as any).gpu;
    if (gpu && (await gpu.requestAdapter())) return 'webgpu';
  } catch {}
  return 'wasm';
}

export class AiChecker {
  private tokenizer: PreTrainedTokenizer | null = null;
  private model: PreTrainedModel | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  status: AiStatus = { state: 'off' };

  async load(opts: AiLoadOptions): Promise<AiStatus> {
    if (this.status.state === 'ready' && this.status.model === opts.model) return this.status;
    const set = (s: AiStatus) => {
      this.status = s;
      opts.onStatus?.(s);
    };
    // The ONNX runtime ships inside the extension: stores forbid loading code from a CDN.
    const ortBase = (globalThis as any).chrome?.runtime?.getURL?.('ort/') ?? '/ort/';
    env.backends.onnx.wasm!.wasmPaths = ortBase;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    if (opts.host) env.remoteHost = opts.host.endsWith('/') ? opts.host : opts.host + '/';
    const device = await pickDevice();
    set({ state: 'loading', progress: 0, device, model: opts.model });
    try {
      let last = -1;
      const progress_callback = (p: any) => {
        if (p.status === 'progress_total') {
          const pct = Math.floor(p.progress);
          if (pct !== last) {
            last = pct;
            set({ state: 'loading', progress: pct, device, model: opts.model });
          }
        }
      };
      this.tokenizer = await AutoTokenizer.from_pretrained(opts.model, { progress_callback });
      this.model = await AutoModelForCausalLM.from_pretrained(opts.model, { dtype: 'q4f16', device, progress_callback });
      set({ state: 'ready', device, model: opts.model });
    } catch (err) {
      set({ state: 'error', error: String(err), device, model: opts.model });
    }
    return this.status;
  }

  /** Corrected version of one sentence (or the sentence itself). Calls are serialized. */
  correct(sentence: string): Promise<string> {
    const run = async () => {
      if (!this.model || !this.tokenizer) throw new Error('model not loaded');
      const inputs = this.tokenizer(buildPrompt(sentence), { add_special_tokens: false });
      const inputLen = (inputs.input_ids as any).dims[1] as number;
      const srcTokens = this.tokenizer(sentence, { add_special_tokens: false });
      const maxNew = Math.ceil((srcTokens.input_ids as any).dims[1] * 1.5) + 8;
      const out = (await this.model.generate({ ...inputs, max_new_tokens: maxNew, do_sample: false } as any)) as any;
      const newTokens = out.slice(null, [inputLen, null]);
      const text = this.tokenizer.batch_decode(newTokens, { skip_special_tokens: true })[0] ?? '';
      return text.split(PROMPT.stop)[0].trim();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
