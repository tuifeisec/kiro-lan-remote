<script setup lang="ts">
/**
 * 会话列表页：安全提示、工作区分组、刷新与全部收起。
 *
 * 双态：
 *   - 默认（移动/单列）：大标题头部 + 安全 banner + 工作区卡片；
 *   - compact（桌面双栏侧栏）：紧凑导航行（新建会话 + 会话数副标题），
 *     安全 banner 仅在连接异常时显示（错误语义不丢，静态提示让位侧栏空间）。
 * 两种形态共用同一数据源与工作区卡片，仅头部与提示区不同。
 */
import { ref } from 'vue';
import { useApp } from '../../app/bootstrap.ts';
import { ICON_COLLAPSE_ALL, ICON_PLUS, ICON_REFRESH } from '../../assets/icons';
import ConnectionStatus from '../layout/ConnectionStatus.vue';
import WorkspaceCard from './WorkspaceCard.vue';

defineProps<{ /** 桌面侧栏紧凑模式。 */ compact?: boolean }>();

const app = useApp();
const { sessions, ui } = app;

const SEC_NOTICE =
  '仅限可信局域网使用。此页面可以驱动你电脑上的 Kiro agent —— 即可以读写文件、执行命令。' +
  '用完请关闭服务（Ctrl+C）。';

/** 每次点「全部收起」自增，卡片 watch 到变化即折叠。 */
const collapseTick = ref(0);

function collapseAll(): void {
  collapseTick.value += 1;
  ui.showToast('已全部收起');
}

function onNewSessionInWorkspace(cwd: string): void {
  ui.cwdInput = cwd || sessions.active?.cwd || '';
  ui.cwdSheetOpen = true;
}

function onNewSession(): void {
  ui.cwdInput = sessions.active?.cwd || '';
  ui.cwdSheetOpen = true;
}

/** 连接副标题：正常连接给官方语义文案（端口收入括号），异常沿用既有语义。 */
const connSubtitle = (): string => {
  if (ui.dot === 'on') {
    return '已连接到当前桌面窗口' + (app.conn.endpoint ? '（:' + app.conn.endpoint.port + '）' : '');
  }
  if (ui.dot === 'wait') return '连接中…';
  if (ui.dot === 'err') return '连接异常';
  return '未连接';
};
</script>

<template>
  <div class="app" :hidden="!compact && ui.view !== 'sessions'">
    <header v-if="compact" class="side-head">
      <button class="side-new-btn" type="button" title="新建会话" @click="onNewSession">
        <span class="i" v-html="ICON_PLUS" />
        <span>新建会话</span>
      </button>
      <span class="side-meta">
        <span class="side-count">{{ sessions.summaryText }}</span>
        <ConnectionStatus :state="ui.dot" />
      </span>
    </header>
    <header v-else>
      <div class="head-inner">
        <div class="head-text">
          <div class="head-title">Kiro 遥控</div>
          <div class="head-subtitle">{{ connSubtitle() }}</div>
        </div>
        <div class="head-actions">
          <ConnectionStatus :state="ui.dot" />
          <button class="icon-btn" type="button" title="新建会话" aria-label="新建会话" @click="onNewSession">
            <span v-html="ICON_PLUS" />
          </button>
        </div>
      </div>
    </header>

    <div class="content">
      <!-- 连接失败时替换为错误横幅；compact 侧栏只保留错误语义，不占静态提示空间 -->
      <div v-if="!compact || ui.connError" class="banner" :class="{ 'banner-err': !!ui.connError }" role="status">
        {{ ui.connError ? '未连接 Kiro：' + ui.connError : SEC_NOTICE }}
      </div>

      <!-- 已有列表时的后台刷新失败：保留旧数据，但必须让用户知道当前不是最新 -->
      <div v-if="sessions.sessions.length && sessions.error" class="banner banner-err" role="status">
        刷新失败，当前显示的是上次数据：{{ sessions.error }}
        <button class="btn mt12" type="button" @click="app.loadSessions(true)">重试</button>
      </div>

      <div class="section-row">
        <div class="sec-text">
          <h1 class="sec-title">工作区和会话</h1>
          <p class="sec-count">{{ sessions.summaryText }}</p>
        </div>
        <div class="sec-actions">
          <button class="icon-btn" type="button" title="全部收起" aria-label="全部收起" @click="collapseAll">
            <span v-html="ICON_COLLAPSE_ALL" />
          </button>
          <button
            class="icon-btn"
            type="button"
            :disabled="sessions.loading"
            :title="sessions.loading ? '刷新中' : '刷新'"
            :aria-label="sessions.loading ? '刷新中' : '刷新'"
            :aria-busy="sessions.loading ? 'true' : 'false'"
            @click="app.loadSessions(true)"
          >
            <span v-if="sessions.loading" class="spin" />
            <span v-else v-html="ICON_REFRESH" />
          </button>
        </div>
      </div>

      <div class="ws-list">
        <div v-if="sessions.loading && !sessions.sessions.length" class="empty">
          <span class="spin" /> 加载中…
        </div>

        <!--
          加载失败且列表为空：换成错误横幅 + 重试按钮（原实现 loadSessions
          的 catch 分支），不与「没有找到会话」叠加 —— 后者是"请求成功但没有
          会话"，两者语义不同，混在一起会让人以为会话丢了。
        -->
        <template v-else-if="!sessions.sessions.length && sessions.error">
          <div class="banner banner-err" role="alert">加载失败：{{ sessions.error }}</div>
          <button class="btn mt12" type="button" @click="app.loadSessions(true)">重试</button>
        </template>

        <div v-else-if="!sessions.sessions.length" class="empty">没有找到会话</div>

        <WorkspaceCard
          v-for="(g, gi) in sessions.groupedSessions"
          :key="g.key"
          :group="g"
          :default-expanded="gi === 0"
          :collapse-tick="collapseTick"
          @open="app.openSession"
          @new-session="onNewSessionInWorkspace"
        />
      </div>
    </div>
  </div>
</template>
