import { generateDetailedSummary, generateSummary } from '../ai/summarizer';
import { fetchRepositoryReadme } from '../crawler/github';
import { fetchTrendingRepositories } from '../crawler/scraper';
import type { TrendItem } from '../crawler/scraper';
import { getLogger } from '../lib/logger';
import {
  createDiscordAdapter,
  type NotificationAdapter,
  type NotificationContent,
} from '../lib/notification';
import { normalizeReadmeMarkdown } from '../lib/readme-normalizer';
import { getRepositories, saveOrUpdateRepository } from '../lib/repository';

const logger = getLogger('scheduler');

export default {
  /**
   * Cronトリガーによって定期実行されるハンドラ
   */
  async scheduled(_event, env, _ctx): Promise<void> {
    logger.info('Starting scheduled task');

    const webhookUrl = env.DISCORD_WEBHOOK_URL?.trim() ?? '';
    if (webhookUrl === '') {
      logger.warn(
        'DISCORD_WEBHOOK_URL is not set or empty. Notifications will be mocked.',
      );
    }
    const notificationAdapter =
      webhookUrl === ''
        ? createMockAdapter()
        : createDiscordAdapter(webhookUrl);

    // 環境変数から言語設定を読み込み
    const languageConfig = loadLanguageConfig(env);

    // 全言語のトレンドを収集
    const allItems: Array<{
      label: string;
      items: (TrendItem & { summary: string })[];
    }> = [];

    for (const config of languageConfig) {
      const result = await processLanguage({
        targetLanguage: config.language,
        limit: config.limit,
        env,
      });
      if (result.items.length > 0) {
        allItems.push(result);
      }
    }

    if (allItems.length > 0) {
      await sendNotifications({ adapter: notificationAdapter, allItems });
    } else {
      logger.info('No trending repositories to notify');
    }

    logger.info('Scheduled task completed');
  },
} satisfies ExportedHandler<CloudflareBindings>;

async function sendNotifications({
  adapter,
  allItems,
}: {
  adapter: NotificationAdapter;
  allItems: Array<{
    label: string;
    items: (TrendItem & { summary: string })[];
  }>;
}): Promise<void> {
  for (const [index, { label, items }] of allItems.entries()) {
    const content: NotificationContent = {
      title:
        label === 'all'
          ? 'GitHub Trending Daily (All Languages)'
          : `GitHub Trending Daily (${label.charAt(0).toUpperCase() + label.slice(1)})`,
      items,
    };

    await adapter.send(content);

    // Discord API のレート制限を避けるため言語ごとの送信間に待機
    if (index < allItems.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

function createMockAdapter(): NotificationAdapter {
  return {
    async send(content: NotificationContent): Promise<void> {
      logger.info(
        { title: content.title, itemCount: content.items.length },
        '[MOCK] Notification would be sent',
      );
    },
  };
}

/**
 * README取得と要約生成(短め・詳細)を行います
 * エラー時は説明文にフォールバック
 */
async function fetchAndSummarize({
  item,
  ai,
}: {
  item: TrendItem;
  ai: Ai;
}): Promise<{ summary: string; detailedSummary: string | null }> {
  try {
    const [owner, repo] = item.name.split('/');
    const readme = await fetchRepositoryReadme({ owner, repo });

    if (!readme) {
      return { summary: item.description, detailedSummary: null };
    }

    const normalizedReadme = normalizeReadmeMarkdown(readme);
    if (normalizedReadme === '') {
      return { summary: item.description, detailedSummary: null };
    }

    const [summary, detailedSummary] = await Promise.all([
      generateSummary({
        ai,
        name: item.name,
        description: item.description,
        readme: normalizedReadme,
      }),
      generateDetailedSummary({
        ai,
        name: item.name,
        description: item.description,
        readme: normalizedReadme,
      }),
    ]);

    return { summary, detailedSummary };
  } catch (e) {
    logger.error({ repo: item.name, err: e }, 'Failed to fetch and summarize');
    return { summary: item.description, detailedSummary: null };
  }
}

/**
 * 特定の言語のトレンドを処理します
 */
async function processLanguage({
  targetLanguage,
  limit,
  env,
}: {
  targetLanguage: string;
  limit: number;
  env: CloudflareBindings;
}): Promise<{ label: string; items: (TrendItem & { summary: string })[] }> {
  const label = targetLanguage;
  logger.info({ lang: label, limit }, 'Processing language');

  try {
    // 1. トレンド取得(件数制限)
    const allTrends = await fetchTrendingRepositories(targetLanguage);
    const trends = allTrends.slice(0, limit);
    logger.info(
      { lang: label, fetched: allTrends.length, using: trends.length },
      'Fetched trending repos',
    );

    // 2. DBから既存データを一括取得
    const urls = trends.map((t) => t.url);
    const existingRepos = await getRepositories(env.DB, urls);

    // 3. 各リポジトリの要約を取得(キャッシュ or 新規生成)
    const enrichedItems = await Promise.all(
      trends.map(async (item) => {
        const existing = existingRepos.get(item.url);
        const repoInput = {
          url: item.url,
          description: item.description,
          language: item.language,
          stars: item.stars,
        };

        // キャッシュがあれば再利用(短め・詳細ともに揃っている場合のみ)
        if (existing?.summary && existing?.detailedSummary) {
          logger.debug({ repo: item.name }, 'Using cached summary');
          await saveOrUpdateRepository(env.DB, repoInput, {
            summary: existing.summary,
            detailedSummary: existing.detailedSummary,
          });
          return { ...item, summary: existing.summary };
        }

        // 新規 or 詳細要約が未生成: README取得 → AI要約
        const { summary, detailedSummary } = await fetchAndSummarize({
          item,
          ai: env.AI,
        });

        // DB保存
        await saveOrUpdateRepository(env.DB, repoInput, {
          summary,
          ...(detailedSummary ? { detailedSummary } : {}),
        });

        return { ...item, summary };
      }),
    );

    return { label, items: enrichedItems };
  } catch (error) {
    logger.error({ lang: label, err: error }, 'Error processing language');
    return { label, items: [] };
  }
}

/**
 * 環境変数から言語設定を読み込む
 */
function loadLanguageConfig(
  env: CloudflareBindings,
): Array<{ language: string; limit: number }> {
  const languages = env.LANGUAGES.split(',');
  const limits = env.LIMITS.split(',').map(Number);

  if (languages.length !== limits.length) {
    throw new Error(
      `LANGUAGES and LIMITS length mismatch: ${languages.length} vs ${limits.length}`,
    );
  }

  return languages.map((language, index) => ({
    language,
    limit: limits[index],
  }));
}
