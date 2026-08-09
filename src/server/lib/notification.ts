import type { TrendItem } from '../crawler/scraper';
import { getLogger } from './logger';

export type NotificationContent = {
  title: string;
  items: (TrendItem & { summary: string })[];
};

export type NotificationAdapter = {
  send(content: NotificationContent): Promise<void>;
};

const logger = getLogger('notification');

function getLanguageColor(language: string): number {
  const colors: Record<string, number> = {
    // GitHub linguist 公式カラー (https://github.com/github/linguist)
    ActionScript: 0x882b0f,
    Ada: 0x02f88c,
    Agda: 0x315665,
    Apex: 0x1797c0,
    Assembly: 0x6e4c13,
    Astro: 0xff5a03,
    AutoHotkey: 0x6594b9,
    Awk: 0xc30e9b,
    Ballerina: 0xff5000,
    Batchfile: 0xc1f12e,
    Brainfuck: 0x2f2530,
    C: 0x555555,
    'C#': 0x178600,
    'C++': 0xf34b7d,
    Carbon: 0x222222,
    Chapel: 0x8dc63f,
    'Classic ASP': 0x6a40fd,
    Clojure: 0xdb5855,
    COBOL: 0xf1a42b,
    CoffeeScript: 0x244776,
    ColdFusion: 0xed2cd6,
    'Common Lisp': 0x3fb68b,
    Coq: 0xd0b68c,
    Crystal: 0x000100,
    CSS: 0x663399,
    Cuda: 0x3a4e3a,
    D: 0xba595e,
    Dart: 0x00b4ab,
    Dockerfile: 0x384d54,
    Elixir: 0x6e4a7e,
    Elm: 0x60b5cc,
    'Emacs Lisp': 0xc065db,
    Erlang: 0xb83998,
    'F#': 0xb845fc,
    Fortran: 0x4d41b1,
    Gleam: 0xffaff3,
    GLSL: 0x5686a5,
    Go: 0x00add8,
    Groovy: 0x4298b8,
    Hack: 0x878787,
    Haskell: 0x5e5086,
    HCL: 0x844fba,
    HLSL: 0xaace60,
    HTML: 0xe34c26,
    Idris: 0xb30000,
    Java: 0xb07219,
    JavaScript: 0xf1e05a,
    Julia: 0xa270ba,
    Kotlin: 0xa97bff,
    LaTeX: 0x008080,
    Lua: 0x000080,
    MATLAB: 0xe16737,
    Move: 0x4a137a,
    Nim: 0xffc200,
    Nix: 0x7e7eff,
    'Objective-C': 0x438eff,
    OCaml: 0xef7a08,
    Odin: 0x60affe,
    Pascal: 0xe3f171,
    Perl: 0x0298c3,
    PHP: 0x4f5d95,
    PowerShell: 0x012456,
    PureScript: 0x1d222d,
    Python: 0x3572a5,
    R: 0x198ce7,
    Racket: 0x3c5caa,
    Raku: 0x0000fb,
    Ruby: 0x701516,
    Rust: 0xdea584,
    Sass: 0xa53b70,
    Scala: 0xc22d40,
    Scheme: 0x1e4aec,
    Shell: 0x89e051,
    Solidity: 0xaa6746,
    Svelte: 0xff3e00,
    Swift: 0xf05138,
    TypeScript: 0x3178c6,
    V: 0x4f87c4,
    VBScript: 0x15dcdc,
    'Visual Basic .NET': 0x945db7,
    Vue: 0x41b883,
    Vyper: 0x9f4cf2,
    WebAssembly: 0x04133b,
    Zig: 0xec915c,
  };
  return colors[language] ?? 0x0099ff; // デフォルトは青
}

export function createDiscordAdapter(webhookUrl: string): NotificationAdapter {
  return {
    async send(content: NotificationContent): Promise<void> {
      logger.info(
        { title: content.title, count: content.items.length },
        'Sending notification to Discord',
      );

      if (content.items.length === 0) {
        logger.info('No items to notify');
        return;
      }

      // Discordの制限は10 embedsまで。安全のため最大10件ずつまとめて送信
      const MAX_EMBEDS_PER_MESSAGE = 10;
      const chunks: (typeof content.items)[] = [];

      for (let i = 0; i < content.items.length; i += MAX_EMBEDS_PER_MESSAGE) {
        chunks.push(content.items.slice(i, i + MAX_EMBEDS_PER_MESSAGE));
      }

      for (const [chunkIndex, chunk] of chunks.entries()) {
        const embeds = chunk.map((item, indexInChunk) => {
          const rank = chunkIndex * MAX_EMBEDS_PER_MESSAGE + indexInChunk + 1;
          return {
            title: `#${rank} ${item.name}`,
            url: item.url,
            description: item.summary,
            color: getLanguageColor(item.language),
            fields: [
              {
                name: 'Language',
                value: item.language || 'Unknown',
                inline: true,
              },
              {
                name: 'Stars',
                value: `⭐ ${item.stars.toLocaleString()} (+${item.starsToday.toLocaleString()} today)`,
                inline: true,
              },
            ],
          };
        });

        const payload = {
          content: chunkIndex === 0 ? `# ${content.title}\n` : undefined,
          embeds,
        };

        try {
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `Discord Webhook failed: ${response.status} ${response.statusText} - ${errorText}`,
            );
          }

          logger.info(
            {
              chunkIndex: chunkIndex + 1,
              totalChunks: chunks.length,
              itemsInChunk: chunk.length,
            },
            'Notification chunk sent',
          );

          // Discord API rate limitを避けるため、チャンク間で待機
          if (chunkIndex < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (error) {
          logger.error(
            { err: error, chunkIndex },
            'Failed to send notification',
          );
          throw error;
        }
      }

      logger.info('All notifications sent successfully');
    },
  };
}
