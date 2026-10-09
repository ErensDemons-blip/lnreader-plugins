import { load as loadCheerio } from 'cheerio';
import { Plugin } from '@/types/plugin';
import { defaultCover } from '@libs/defaultCover';
import { fetchApi, FetchInit } from '@libs/fetch';
import { Filters, FilterTypes } from '@libs/filterInputs';
import { NovelStatus } from '@libs/novelStatus';

class NovelpiaGlobalPlugin implements Plugin.PluginBase {
  id = 'novelpiaGlobal';
  name = 'Novelpia Global';
  icon = 'src/en/novelpiaglobal/icon.png';
  site = 'https://global.novelpia.com';
  api = 'https://api-global.novelpia.com';
  version = '1.1.0';

  private accessToken = '';
  private readonly anonymousKey = this.createAnonymousKey();

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: {
      Referer: `${this.site}/`,
    },
  };

  private readonly baseHeaders = {
    'Accept': 'application/json, text/plain, */*',
    'Origin': this.site,
    'Referer': `${this.site}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };

  private async fetchJson<T>(path: string, init?: FetchInit): Promise<T> {
    const response = await fetchApi(`${this.api}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...this.baseHeaders,
        ...(init?.headers || {}),
      },
    });

    let data: ApiResponse<T> | undefined;
    try {
      data = (await response.json()) as ApiResponse<T>;
    } catch {
      // The HTTP status below still gives callers a useful error.
    }

    if (!response.ok) {
      const error = new Error(
        data?.errmsg || `Novelpia request failed (${response.status})`,
      ) as NovelpiaRequestError;
      error.name = 'NovelpiaRequestError';
      error.status = response.status;
      throw error;
    }

    if (!data || data.statusCode !== 200 || !data.result) {
      throw new Error(data?.errmsg || 'Novelpia returned an invalid response');
    }

    return data.result;
  }

  private mapNovelItem(row: NovelListRow): Plugin.NovelItem {
    const novel = row.novel;
    return {
      name: novel.novel_name.trim(),
      path: `/novel/${novel.novel_no}`,
      cover: novel.novel_img || novel.novel_full_img || defaultCover,
    };
  }

  private async getNovelList(
    pageNo: number,
    searchTerm: string,
    sortColumn: string,
    filters?: FilterValues,
  ): Promise<Plugin.NovelItem[]> {
    const params = new URLSearchParams({
      page: String(pageNo),
      rows: '30',
      search_type: 'all',
      search_val: searchTerm,
      sort_col: sortColumn,
      sort: 'desc',
      flag_adult: '0',
    });

    if (filters?.status.value) {
      params.set('flag_complete', filters.status.value);
    }
    if (filters?.novelType.value) {
      params.set('novel_type', filters.novelType.value);
    }

    const result = await this.fetchJson<NovelListResult>(
      `/v1/novel/search?${params.toString()}`,
    );

    return (result.list || []).map(row => this.mapNovelItem(row));
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const sortColumn = showLatestNovels
      ? 'new_epi_open_dt'
      : filters.sort.value;
    return this.getNovelList(pageNo, '', sortColumn, filters);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    return this.getNovelList(pageNo, searchTerm, 'new_epi_open_dt');
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const match = novelPath.match(/(?:^|\/)novel\/(\d+)/);
    if (!match) throw new Error('Invalid Novelpia novel path');

    const novelNo = match[1];
    const result = await this.fetchJson<NovelResult>(
      `/v1/novel?novel_no=${novelNo}`,
    );
    const metadata = result.novel;
    const episodeCount = Number(
      result.info?.epi_cnt || metadata.count_epi || 0,
    );
    const freeEpisodeCount =
      result.info?.free_epi_cnt == null
        ? episodeCount
        : Number(result.info.free_epi_cnt);
    const rows = Math.max(1000, episodeCount + 10);
    const episodeResult = await this.fetchJson<EpisodeListResult>(
      `/v1/novel/episode/list?novel_no=${novelNo}&rows=${rows}&sort=ASC`,
    );

    const chapters = (episodeResult.list || [])
      .filter(episode => episode.flag_open !== 0)
      .map((episode, index) => {
        const requiresOfficialAccess = index >= freeEpisodeCount;
        return {
          name: requiresOfficialAccess
            ? `🔒 ${episode.epi_title}`
            : episode.epi_title,
          path: `/viewer/${episode.episode_no}`,
          releaseTime: episode.open_dt,
          chapterNumber: Number(episode.epi_num),
        };
      });

    const tagList = result.tag_list || metadata.tag_list || [];
    const genres = tagList
      .map(tag => (typeof tag === 'string' ? tag : tag.tag_name))
      .filter(Boolean)
      .join(', ');

    return {
      path: `/novel/${novelNo}`,
      name: metadata.novel_name.trim(),
      cover: metadata.novel_full_img || metadata.novel_img || defaultCover,
      summary: metadata.novel_story,
      author: result.writer_list?.map(writer => writer.writer_name).join(', '),
      genres,
      status:
        String(metadata.flag_complete) === '1'
          ? NovelStatus.Completed
          : NovelStatus.Ongoing,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const match = chapterPath.match(/(?:^|\/)viewer\/(\d+)/);
    if (!match) throw new Error('Invalid Novelpia chapter path');

    const episodeNo = match[1];
    const headers: Record<string, string> = {
      ...this.baseHeaders,
      'Referer': `${this.site}/viewer/${episodeNo}`,
      'Cookie': `USERKEY=${this.anonymousKey}`,
    };
    let ticket: EpisodeTicketResult;

    try {
      ticket = await this.fetchEpisodeTicket(episodeNo, headers);
    } catch (error) {
      if (!this.isUnauthorized(error)) {
        throw error;
      }

      const accessToken = await this.refreshAccessToken();
      if (!accessToken) {
        throw new Error(
          'Novelpia login required. Open this source in WebView, sign in, then try the download again.',
        );
      }

      headers['Login-At'] = accessToken;
      ticket = await this.fetchEpisodeTicket(episodeNo, headers);
    }

    const token = ticket._t;

    if (!token) {
      throw new Error(
        'This chapter requires access through the official Novelpia website or app.',
      );
    }

    const content = await this.fetchJson<EpisodeContentResult>(
      `/v1/novel/episode/content?_t=${encodeURIComponent(token)}`,
      { headers },
    );
    const data = content.data || {};
    const chapterHtml = Object.keys(data)
      .filter(key => /^epi_content\d*$/.test(key))
      .sort((a, b) => this.contentPartNumber(a) - this.contentPartNumber(b))
      .map(key => data[key])
      .join('')
      .trim();

    if (!chapterHtml) {
      throw new Error(
        'This chapter is not publicly readable without official access.',
      );
    }

    const $ = loadCheerio(`<body>${chapterHtml}</body>`);
    $('script, style, iframe, form').remove();
    return $('body').html() || '';
  }

  private fetchEpisodeTicket(
    episodeNo: string,
    headers: Record<string, string>,
  ): Promise<EpisodeTicketResult> {
    if (this.accessToken) headers['Login-At'] = this.accessToken;
    return this.fetchJson<EpisodeTicketResult>(
      `/v1/novel/episode?episode_no=${episodeNo}`,
      { headers },
    );
  }

  private async refreshAccessToken(): Promise<string> {
    try {
      const result =
        await this.fetchJson<LoginRefreshResult>('/v1/login/refresh');
      this.accessToken = result.LOGINAT || '';
    } catch (error) {
      if (!this.isUnauthorized(error)) {
        throw error;
      }
      this.accessToken = '';
    }

    return this.accessToken;
  }

  private isUnauthorized(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      (error as NovelpiaRequestError).status === 401
    );
  }

  resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.site}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private createAnonymousKey(): string {
    return Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
  }

  private contentPartNumber(key: string): number {
    const match = key.match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  filters = {
    sort: {
      label: 'Sort',
      value: 'count_view',
      options: [
        { label: 'Popular', value: 'count_view' },
        { label: 'Latest updates', value: 'new_epi_open_dt' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      label: 'Status',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Ongoing', value: '0' },
        { label: 'Completed', value: '1' },
      ],
      type: FilterTypes.Picker,
    },
    novelType: {
      label: 'Novel type',
      value: '',
      options: [
        { label: 'All', value: '' },
        { label: 'Indie', value: 'indie' },
        { label: 'Original', value: 'original' },
        { label: 'K-Premium', value: 'ko' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new NovelpiaGlobalPlugin();

type ApiResponse<T> = {
  statusCode: number;
  errmsg?: string;
  result?: T;
};

type NovelSummary = {
  novel_no: number;
  novel_name: string;
  novel_img?: string;
  novel_full_img?: string;
  novel_story?: string;
  flag_complete?: number | string;
  count_epi?: number | string;
  tag_list?: NovelTag[];
};

type NovelListRow = {
  novel: NovelSummary;
};

type NovelListResult = {
  list: NovelListRow[];
  total_cnt: number;
};

type NovelTag = {
  tag_name?: string;
};

type NovelResult = {
  novel: NovelSummary;
  info?: {
    epi_cnt?: number | string;
    free_epi_cnt?: number | string;
  };
  writer_list?: { writer_name: string }[];
  tag_list?: (NovelTag | string)[];
};

type EpisodeListResult = {
  list: {
    episode_no: number;
    epi_num: number;
    epi_title: string;
    open_dt?: string;
    flag_open?: number;
  }[];
};

type EpisodeTicketResult = {
  _t?: string;
};

type EpisodeContentResult = {
  data?: Record<string, string>;
};

type LoginRefreshResult = {
  LOGINAT?: string;
};

type NovelpiaRequestError = Error & { status: number };

type FilterValues = Plugin.PopularNovelsOptions<
  typeof NovelpiaGlobalPlugin.prototype.filters
>['filters'];
