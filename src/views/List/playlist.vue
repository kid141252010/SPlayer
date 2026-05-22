<!-- 歌单列表 -->
<template>
  <div class="playlist-list">
    <ListDetail
      :detail-data="detailData?.id === playlistId ? detailData : null"
      :list-data="detailData?.id === playlistId ? listData : []"
      :loading="showLoading"
      :list-scrolling="listScrolling"
      :search-value="searchValue"
      :config="listConfig"
      :play-button-text="playButtonText"
      :more-options="moreOptions"
      :hide-comment-tab="isLocalPlaylist || detailData?.privacy === 10"
      @update:search-value="handleSearchUpdate"
      @play-all="playAllSongs"
      @tab-change="handleTabChange"
    >
      <template #action-buttons>
        <n-button
          v-if="isUserPlaylist"
          :focusable="false"
          strong
          secondary
          round
          @click="updatePlaylist"
        >
          <template #icon>
            <SvgIcon name="EditNote" />
          </template>
          编辑歌单
        </n-button>
        <n-button
          v-else
          :focusable="false"
          strong
          secondary
          round
          @click="toLikePlaylist(playlistId, !isLikePlaylist)"
        >
          <template #icon>
            <SvgIcon :name="isLikePlaylist ? 'Favorite' : 'FavoriteBorder'" />
          </template>
          {{ isLikePlaylist ? "取消收藏" : "收藏歌单" }}
        </n-button>
      </template>
    </ListDetail>
    <!-- 歌曲列表 -->
    <template v-if="currentTab === 'songs'">
      <SongList
        v-if="!searchValue || searchData?.length"
        :data="detailData?.id === playlistId ? displayData : []"
        :loading="loading"
        :height="songListHeight"
        :type="isPodcastPlaylist ? 'radio' : 'song'"
        :playListId="playlistId"
        :draggable="canDragSort"
        :doubleClickAction="searchData?.length ? 'add' : 'all'"
        @scroll="handleListScroll"
        @removeSong="removeSong"
        @reorder="handleReorder"
      />
      <n-empty
        v-else
        :description="`搜不到关于 ${searchValue} 的任何歌曲呀`"
        style="margin-top: 60px"
        size="large"
      >
        <template #icon>
          <SvgIcon name="SearchOff" />
        </template>
      </n-empty>
    </template>
    <!-- 评论 -->
    <ListComment
      v-show="currentTab === 'comments'"
      :id="playlistId"
      :type="2"
      :height="songListHeight"
    />
  </div>
</template>

<script setup lang="ts">
import type { DropdownOption, MessageReactive } from "naive-ui";
import { SongType } from "@/types/main";
import { songDetail } from "@/api/song";
import {
  playlistDetail,
  playlistAllSongs,
  deletePlaylist,
  updatePlaylistPrivacy,
  songOrderUpdate,
  voiceListDetail,
  voiceListSearch,
  voiceListPrograms,
} from "@/api/playlist";
import { formatCoverList, formatSongsList } from "@/utils/format";
import {
  extractVoiceListPrograms,
  isMixPodcastPlaylist,
  resolveVoiceListIdFromSearch,
  shouldFallbackToPlaylistTrackAll,
} from "@/utils/playlistTrack";
import { renderIcon, copyData, getShareUrl } from "@/utils/helper";
import { isLogin, toLikePlaylist, updateUserLikePlaylist } from "@/utils/auth";
import { useDataStore, useLocalStore, useStatusStore } from "@/stores";
import { openBatchList, openUpdatePlaylist } from "@/utils/modal";
import { useListDetail } from "@/composables/List/useListDetail";
import { useListSearch } from "@/composables/List/useListSearch";
import { useListScroll } from "@/composables/List/useListScroll";
import { useListActions } from "@/composables/List/useListActions";
import { useListDataCache, type ListCacheData } from "@/composables/List/useListDataCache";

const router = useRouter();
const dataStore = useDataStore();
const localStore = useLocalStore();
const statusStore = useStatusStore();

const {
  detailData,
  listData,
  loading,
  getSongListHeight,
  setDetailData,
  setListData,
  appendListData,
  setLoading,
} = useListDetail();
const { searchValue, searchData, displayData, clearSearch, performSearch } =
  useListSearch(listData);
const { listScrolling, handleListScroll, resetScroll } = useListScroll();
const { playAllSongs: playAllSongsAction } = useListActions();
const { saveCache, loadCache, checkNeedsUpdate } = useListDataCache();

// 歌单 ID
const oldPlaylistId = ref<number>(0);
const playlistId = computed<number>(() => Number(router.currentRoute.value.query.id as string));

// 当前正在请求的歌单 ID，用于防止竞态条件
const currentRequestId = ref<number>(0);

// 是否为播客歌单
const isPodcastPlaylist = ref<boolean>(false);

// 加载提示
const loadingMsg = ref<MessageReactive | null>(null);

// 列表高度
const songListHeight = computed(() => getSongListHeight(listScrolling.value));

// 当前 tab
const currentTab = ref<"songs" | "comments">("songs");

// 是否为本地歌单
const isLocalPlaylist = computed(() => {
  return localStore.isLocalPlaylist(playlistId.value);
});

// 是否为用户歌单
const isUserPlaylist = computed(() => {
  if (isLocalPlaylist.value) return true;
  return detailData.value?.creator?.id === dataStore.userData?.userId;
});

// 是否处于收藏歌单
const isLikePlaylist = computed(() => {
  return dataStore.userLikeData.playlists.some((playlist) => playlist.id === detailData.value?.id);
});

// 是否可拖拽排序（用户自建歌单 + 默认排序 + 非搜索模式）
const canDragSort = computed(() => {
  return (
    isUserPlaylist.value &&
    !isPodcastPlaylist.value &&
    !searchValue.value &&
    statusStore.listSortField === "default"
  );
});

// 是否处于歌单页面
const isPlaylistPage = computed<boolean>(() => router.currentRoute.value.name === "playlist");

// 是否为相同歌单
const isSamePlaylist = computed<boolean>(() => oldPlaylistId.value === playlistId.value);

// 列表配置
const listConfig = computed(() => ({
  titleType: "normal" as const,
  showCoverMask: true,
  showPlayCount: !isLocalPlaylist.value,
  showArtist: false,
  showCreator: !isLocalPlaylist.value,
  showCount: false,
  searchAlign: "center" as const,
}));

// 是否显示加载状态
const showLoading = computed(() => listData.value.length === 0 && loading.value);

// 播放按钮文本
const playButtonText = computed(() => {
  if (showLoading.value) {
    if (isSamePlaylist.value) {
      return "更新中...";
    }
    const loaded =
      listData.value.length === (detailData.value?.count || 0) ? 0 : listData.value.length;
    return `加载中... (${loaded}/${detailData.value?.count || 0})`;
  }
  return "播放";
});

// 更多操作
const moreOptions = computed<DropdownOption[]>(() => [
  {
    label: "刷新缓存",
    key: "refresh",
    show: !isLocalPlaylist.value,
    props: {
      onClick: () => getPlaylistDetail(playlistId.value, { getList: true, refresh: true }),
    },
    icon: renderIcon("Refresh"),
  },
  {
    label: "公开隐私歌单",
    key: "privacy",
    show: !isLocalPlaylist.value && detailData.value?.privacy === 10,
    props: { onClick: openPrivacy },
    icon: renderIcon("ListLockOpen"),
  },
  {
    label: "删除歌单",
    key: "delete",
    show: isUserPlaylist.value,
    props: {
      onClick: () => toDeletePlaylist(),
    },
    icon: renderIcon("Delete"),
  },
  {
    label: "批量操作",
    key: "batch",
    props: {
      onClick: () =>
        openBatchList(
          displayData.value,
          isLocalPlaylist.value,
          isUserPlaylist.value ? playlistId.value : undefined,
        ),
    },
    icon: renderIcon("Batch"),
  },
  {
    label: "复制分享链接",
    key: "copy",
    show: !isLocalPlaylist.value,
    props: {
      onClick: () => copyData(getShareUrl("playlist", playlistId.value), "已复制分享链接到剪贴板"),
    },
    icon: renderIcon("Share"),
  },
  {
    label: "打开源页面",
    key: "open",
    show: !isLocalPlaylist.value,
    props: {
      onClick: () => {
        window.open(`https://music.163.com/#/playlist?id=${playlistId.value}`);
      },
    },
    icon: renderIcon("Link"),
  },
]);

// 获取歌单基础信息
const getPlaylistDetail = async (
  id: number,
  options: { getList: boolean; refresh: boolean } = { getList: true, refresh: false },
) => {
  if (!id) return;
  // 设置当前请求的歌单 ID，用于防止竞态条件
  currentRequestId.value = id;
  // 设置加载状态
  setLoading(true);
  const { getList, refresh } = options;
  // 清空数据
  clearSearch();
  if (!refresh && detailData.value?.id !== id) resetPlaylistData(getList);
  // 等待本地歌单加载
  if (id.toString().length === 16 && !localStore.isInitialized) {
    try {
      await localStore.readLocalPlaylists();
    } catch (e) {
      window.$message.error("获取本地歌单失败");
      console.error("Failed to init local playlists", e);
    }
  }
  // 判断是否为本地歌单，本地歌单 ID 为 16 位
  const isLocal = localStore.isLocalPlaylist(id);
  // 本地歌单
  if (isLocal) handleLocalPlaylist(id);
  // 在线歌单
  else {
    try {
      await handleOnlinePlaylist(id, getList, refresh);
    } catch (error) {
      console.error("Failed to load playlist", error);
      window.$message.error("获取歌单详情失败");
      setLoading(false);
      router.push("/");
    }
  }
};

// 重置歌单数据
const resetPlaylistData = (getList: boolean) => {
  setDetailData(null);
  isPodcastPlaylist.value = false;
  if (getList) {
    setListData([]);
    resetScroll();
  }
};

// 兼容播客详情接口的多种包装
const getVoiceListDetailData = (detail: any) => {
  return detail?.data || detail?.voiceList || detail?.voicelist || detail;
};

const isVoiceListLoginRequired = (payload: any) => {
  return (
    payload?.code === 301 ||
    payload?.data?.code === 301 ||
    payload?.body?.code === 301 ||
    payload?.response?.status === 301 ||
    payload?.response?.data?.code === 301
  );
};

// 搜索真实播客列表 ID
const resolvePodcastVoiceListId = async (playlistName?: string, creatorUserId?: number) => {
  if (!playlistName) return null;
  const result = await voiceListSearch(playlistName, 30, 0);
  if (isVoiceListLoginRequired(result)) {
    throw Object.assign(new Error("Voice list login required"), { code: 301 });
  }
  return resolveVoiceListIdFromSearch(result, playlistName, creatorUserId);
};

// 获取本地歌单
const handleLocalPlaylist = (id: number) => {
  isPodcastPlaylist.value = false;
  const result = localStore.getLocalPlaylistDetail(id);
  if (!result) {
    window.$message.error("本地歌单不存在");
    setLoading(false);
    return;
  }
  const { playlist, songs } = result;
  // 获取封面：优先使用歌单封面，否则取第一首歌曲的封面
  let cover = playlist.cover;
  if (!cover && songs.length > 0) {
    cover = songs[0].cover;
  }
  // 转换为 CoverType 格式
  setDetailData({
    id: playlist.id,
    name: playlist.name,
    cover: cover || "/images/album.jpg?asset",
    description: playlist.description,
    count: playlist.songs.length,
    createTime: playlist.createTime,
    updateTime: playlist.updateTime,
  });
  setListData(songs);
  setLoading(false);
};

// 获取在线歌单
const handleOnlinePlaylist = async (id: number, getList: boolean, refresh: boolean) => {
  // 1. 尝试读取缓存
  if (!refresh && getList) {
    const cached = await loadCache("playlist", id);
    if (cached?.songs?.length) {
      setDetailData(cached.detail);
      setListData(cached.songs);
      isPodcastPlaylist.value = cached.songs.some((song) => song.type === "radio");
      setLoading(false);

      // 后台检查更新
      backgroundCheck(id, cached);
      return;
    }
  }

  // 获取歌单详情
  const detail = await playlistDetail(id);
  // 检查是否仍然是当前请求的歌单
  if (currentRequestId.value !== id) return;
  isPodcastPlaylist.value = isMixPodcastPlaylist(detail.playlist);
  setDetailData(formatCoverList(detail.playlist)[0]);
  const count = detailData.value?.count || 0;
  const loadPlaylistAllSongs = async () => {
    if (!refresh) setListData([]);
    await getPlaylistAllSongs(id, count, refresh);
  };
  if (!getList) {
    setLoading(false);
    return;
  }
  if (isPodcastPlaylist.value) {
    await getPodcastPlaylistPrograms(id, refresh);
    if (currentRequestId.value !== id) return;
    setLoading(false);
    return;
  }
  // 不需要获取列表或无歌曲
  if (count === 0) {
    setLoading(false);
    return;
  }
  // 如果已登录且歌曲数量少于 800，直接加载所有歌曲
  if (isLogin() === 1 && count === detail.privileges?.length && count < 800) {
    const ids = detail.privileges.map((song: any) => song.id as number);
    const result = await songDetail(ids);
    // 检查是否仍然是当前请求的歌单
    if (currentRequestId.value !== id) return;
    const songs = formatSongsList(result.songs);
    if (shouldFallbackToPlaylistTrackAll(ids, songs)) {
      await loadPlaylistAllSongs();
    } else {
      setListData(songs);
      // 保存缓存
      saveCache("playlist", id, detailData.value!, songs);
    }
  } else {
    await loadPlaylistAllSongs();
  }
  // 检查是否仍然是当前请求的歌单
  if (currentRequestId.value !== id) return;
  setLoading(false);
};

// 获取播客歌单全部节目
const getPodcastPlaylistPrograms = async (id: number, refresh: boolean = false) => {
  const isLoginRequiredError = (error: any) => {
    return isVoiceListLoginRequired(error) || error?.code === 301;
  };

  if (isLogin() !== 1) {
    window.$message.warning("请登录后查看播客歌单");
    setListData([]);
    return;
  }

  if (!refresh) setListData([]);
  setLoading(true);

  const limit = 200;
  let offset = 0;
  let total = Number(detailData.value?.count || 0);
  const listDataArray: SongType[] = [];
  let fetchedAllPrograms = false;
  let voiceListId: number | null = null;

  try {
    voiceListId = await resolvePodcastVoiceListId(
      detailData.value?.name,
      detailData.value?.creator?.id,
    );
  } catch (error: any) {
    if (isLoginRequiredError(error)) {
      window.$message.warning("请登录后查看播客歌单");
      setListData([]);
      return;
    }
    console.error("Failed to resolve podcast playlist id", error);
    window.$message.error("获取播客歌单失败");
    return;
  }

  if (currentRequestId.value !== id) return;
  if (!voiceListId) {
    window.$message.error("未找到该歌单对应的播客列表");
    return;
  }

  try {
    const detail = await voiceListDetail(voiceListId);
    if (isVoiceListLoginRequired(detail)) {
      window.$message.warning("请登录后查看播客歌单");
      setListData([]);
      return;
    }
    if (currentRequestId.value !== id) return;
    const voiceDetail = getVoiceListDetailData(detail);
    const formattedDetail = formatCoverList(voiceDetail)[0];
    if (formattedDetail && detailData.value && (formattedDetail.name || formattedDetail.cover)) {
      setDetailData({
        ...detailData.value,
        ...formattedDetail,
        id,
        count: formattedDetail.count || detailData.value.count,
      });
      total = Number(formattedDetail.count || total || 0);
    }
  } catch (error: any) {
    if (isLoginRequiredError(error)) {
      window.$message.warning("请登录后查看播客歌单");
      setListData([]);
      return;
    }
    console.error("Failed to load podcast playlist detail", error);
  }

  do {
    if (currentRequestId.value !== id) return;
    try {
      const result = await voiceListPrograms(voiceListId, limit, offset);
      if (isVoiceListLoginRequired(result)) {
        window.$message.warning("请登录后查看播客歌单");
        setListData([]);
        return;
      }
      if (currentRequestId.value !== id) return;
      const programs = extractVoiceListPrograms(result);
      if (!programs.length) {
        fetchedAllPrograms = listDataArray.length > 0 && (!total || offset >= total);
        break;
      }
      const songs = formatSongsList(programs);
      listDataArray.push(...songs);
      if (!refresh) appendListData(songs);
      const resultTotal = Number(result?.data?.total ?? result?.total ?? 0);
      if (resultTotal > 0) total = resultTotal;
      offset += limit;
      if (programs.length < limit || (total > 0 && offset >= total)) {
        fetchedAllPrograms = true;
        break;
      }
    } catch (error: any) {
      if (isLoginRequiredError(error)) {
        window.$message.warning("请登录后查看播客歌单");
      } else {
        console.error("Failed to load podcast playlist programs", error);
        window.$message.error("获取播客歌单失败");
      }
      break;
    }
  } while ((!total || offset < total) && isPlaylistPage.value && currentRequestId.value === id);

  if (currentRequestId.value !== id) return;
  if (refresh) setListData(listDataArray);
  if (detailData.value && listDataArray.length > 0 && fetchedAllPrograms) {
    saveCache("playlist", id, detailData.value, listDataArray);
  }
};

// 后台检查更新
const backgroundCheck = async (id: number, cached: ListCacheData) => {
  try {
    const hasRadioSongs = cached.songs.some((song) => song.type === "radio");
    const latestDetail = hasRadioSongs
      ? await (async () => {
          const voiceListId = await resolvePodcastVoiceListId(
            cached.detail.name,
            cached.detail.creator?.id,
          );
          if (!voiceListId) return null;
          return formatCoverList(getVoiceListDetailData(await voiceListDetail(voiceListId)))[0];
        })()
      : formatCoverList((await playlistDetail(id)).playlist)[0];
    if (currentRequestId.value !== id) return;

    if (latestDetail && checkNeedsUpdate(cached, latestDetail)) {
      console.log("Cache expired, refreshing...");
      handleOnlinePlaylist(id, true, true);
    }
  } catch (e) {
    console.error("Background check failed", e);
  }
};

// 获取歌单全部歌曲
const getPlaylistAllSongs = async (
  id: number,
  count: number,
  // 是否为刷新列表
  refresh: boolean = false,
) => {
  setLoading(true);
  // 加载提示
  loadingMsgShow(!refresh, count);
  // 循环获取
  let offset: number = 0;
  const limit: number = 500;
  const listDataArray: SongType[] = [];
  do {
    // 检查是否仍然是当前请求的歌单
    if (currentRequestId.value !== id) {
      loadingMsgShow(false);
      return;
    }
    const result = await playlistAllSongs(id, limit, offset);
    // 再次检查是否仍然是当前请求的歌单（请求完成后）
    if (currentRequestId.value !== id) {
      loadingMsgShow(false);
      return;
    }
    const songData = formatSongsList(result.songs);
    listDataArray.push(...songData);
    if (!refresh) {
      appendListData(songData);
    }
    // 更新数据
    offset += limit;
  } while (offset < count && isPlaylistPage.value && currentRequestId.value === id);
  // 最终检查是否仍然是当前请求的歌单
  if (currentRequestId.value !== id) {
    loadingMsgShow(false);
    return;
  }
  if (refresh) setListData(listDataArray);
  // 保存缓存
  if (detailData.value && listDataArray.length > 0) {
    saveCache("playlist", id, detailData.value, listDataArray);
  }

  // 关闭加载
  loadingMsgShow(false);
};

// 处理搜索更新
const handleSearchUpdate = (val: string) => {
  searchValue.value = val;
  performSearch(val);
};

// 处理 tab 切换
const handleTabChange = (value: "songs" | "comments") => {
  currentTab.value = value;
};

// 播放全部歌曲
const playAllSongs = useDebounceFn(() => {
  if (!detailData.value || !displayData.value?.length) return;
  playAllSongsAction(displayData.value, playlistId.value);
}, 300);

// 加载提示
const loadingMsgShow = (show: boolean = true, count?: number) => {
  if (show) {
    if (count && count <= 800) return;
    loadingMsg.value?.destroy();
    loadingMsg.value = window.$message.loading("该歌单歌曲数量过多，请稍等", {
      duration: 0,
      closable: true,
    });
  } else {
    loadingMsg.value?.destroy();
    loadingMsg.value = null;
  }
};

// 删除歌单
const toDeletePlaylist = async () => {
  if (!detailData.value || !playlistId.value) return;
  window.$dialog.warning({
    title: "删除歌单",
    content: "确认删除这个歌单？该操作无法撤销！",
    positiveText: "删除",
    negativeText: "取消",
    onPositiveClick: async () => {
      // 本地歌单
      if (isLocalPlaylist.value) {
        const success = await localStore.deleteLocalPlaylist(playlistId.value);
        if (success) {
          window.$message.success("本地歌单删除成功");
          router.back();
        } else {
          window.$message.error("删除失败");
        }
        return;
      }
      // 在线歌单
      const result = await deletePlaylist(playlistId.value);
      if (result.code === 200) {
        window.$message.success("歌单删除成功");
        // 更新用户歌单
        if (dataStore.userData.createdPlaylistCount) {
          dataStore.userData.createdPlaylistCount -= 1;
          await updateUserLikePlaylist();
        }
      }
    },
  });
};

// 删除指定索引歌曲
const removeSong = async (ids: number[]) => {
  if (!listData.value) return;
  // 如果是本地歌单，同步删除存储中的数据
  if (isLocalPlaylist.value) {
    const songIds = ids.map((id) => id.toString());
    const success = await localStore.removeSongsFromLocalPlaylist(playlistId.value, songIds);
    if (!success) {
      window.$message.error("删除失败");
      return;
    }
  }
  setListData(listData.value.filter((song) => !ids.includes(song.id)));
};

// 拖拽重排序
const handleReorder = async (fromIndex: number, toIndex: number) => {
  if (fromIndex === toIndex) return;

  // 乐观更新视图
  const newList = [...listData.value];
  const [moved] = newList.splice(fromIndex, 1);
  newList.splice(toIndex, 0, moved);
  setListData(newList);

  if (isLocalPlaylist.value) {
    // 本地歌单持久化
    const success = await localStore.reorderSongsInLocalPlaylist(
      playlistId.value,
      fromIndex,
      toIndex,
    );
    if (!success) {
      window.$message.error("排序失败");
      handleLocalPlaylist(playlistId.value);
    }
  } else {
    // 在线歌单持久化
    try {
      const ids = newList.map((s) => s.id);
      const result = await songOrderUpdate(playlistId.value, ids);
      if (result.code !== 200) {
        window.$message.error("保存排序失败");
        getPlaylistDetail(playlistId.value, { getList: true, refresh: true });
      } else {
        // 更新缓存
        if (detailData.value) {
          saveCache("playlist", playlistId.value, detailData.value, newList);
        }
      }
    } catch (error) {
      console.error("Failed to update song order:", error);
      window.$message.error("保存排序失败，请重试");
      getPlaylistDetail(playlistId.value, { getList: true, refresh: true });
    }
  }
};

// 编辑歌单
const updatePlaylist = () => {
  if (!detailData.value || !playlistId.value) return;
  openUpdatePlaylist(
    playlistId.value,
    detailData.value,
    () => getPlaylistDetail(playlistId.value, { getList: false, refresh: false }),
    isLocalPlaylist.value,
  );
};

// 公开隐私歌单
const openPrivacy = async () => {
  if (detailData.value?.privacy !== 10) return;
  window.$dialog.warning({
    title: "公开隐私歌单",
    content: "确认公开这个歌单？该操作无法撤销！",
    positiveText: "公开",
    negativeText: "取消",
    onPositiveClick: async () => {
      const result = await updatePlaylistPrivacy(playlistId.value);
      if (result.code !== 200) return;
      if (detailData.value) detailData.value.privacy = 0;
      window.$message.success("歌单公开成功");
    },
  });
};

onBeforeRouteUpdate((to) => {
  const id = Number(to.query.id as string);
  if (id) {
    currentTab.value = "songs";
    oldPlaylistId.value = id;
    getPlaylistDetail(id);
  }
});

onActivated(() => {
  // 是否为首次进入
  if (oldPlaylistId.value === 0) {
    oldPlaylistId.value = playlistId.value;
  } else {
    oldPlaylistId.value = playlistId.value;
    // 刷新歌单
    getPlaylistDetail(playlistId.value, { getList: true, refresh: false });
  }
});

onDeactivated(() => loadingMsgShow(false));
onUnmounted(() => loadingMsgShow(false));
onMounted(() => getPlaylistDetail(playlistId.value));
</script>
