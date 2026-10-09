// tsc -b（npm run build）でも jest-dom のマッチャーの型を解決できるようにする（実行時の登録は vitest.setup.ts で済んでいる）
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTracksToPlaylist,
  fetchPlaylistItems,
  removeTracksFromPlaylist,
  reorderPlaylistTracks,
  searchSpotify,
  updatePlaylist,
  type Paging,
  type SpotifyPlaylist,
  type SpotifyPlaylistItem,
  type SpotifyTrack,
} from "../api";
import EditPlaylistModal from "./EditPlaylistModal";

// 外部への通信（バックエンド経由の Spotify API 呼び出し）はすべてモックに差し替える
vi.mock("../api", () => ({
  fetchPlaylistItems: vi.fn(),
  searchSpotify: vi.fn(),
  addTracksToPlaylist: vi.fn(),
  removeTracksFromPlaylist: vi.fn(),
  reorderPlaylistTracks: vi.fn(),
  updatePlaylist: vi.fn(),
}));

function makeTrack(key: string, overrides: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: `track-${key}`,
    name: `曲${key}`,
    uri: `spotify:track:${key}`,
    preview_url: null,
    external_urls: { spotify: `https://open.spotify.com/track/${key}` },
    artists: [{ id: `artist-${key}`, name: `アーティスト${key}` }],
    album: { id: `album-${key}`, name: `アルバム${key}`, images: [] },
    ...overrides,
  };
}

function searchResponse(tracks: SpotifyTrack[]) {
  return { tracks: { items: tracks } };
}

function playlistItems(items: SpotifyPlaylistItem[]): Paging<SpotifyPlaylistItem> {
  return { items, total: items.length, next: null, previous: null, limit: 100, offset: 0 };
}

/** 解決するタイミングをテスト側で決められる Promise */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const playlist: SpotifyPlaylist = {
  id: "playlist-1",
  name: "お気に入り",
  public: true,
  tracks: { total: 3 },
  images: [],
  owner: { id: "user-1" },
};
const trackA = makeTrack("A", {
  album: {
    id: "album-A",
    name: "アルバムA",
    images: [{ url: "https://example.com/album-a.jpg", width: 64, height: 64 }],
  },
});
const trackB = makeTrack("B");
const trackC = makeTrack("C");
const trackD = makeTrack("D");
const trackE = makeTrack("E");

function renderModal({ isOpen = true } = {}) {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onPlaylistUpdated = vi.fn();
  const ui = (open: boolean) => (
    <EditPlaylistModal isOpen={open} onClose={onClose} onPlaylistUpdated={onPlaylistUpdated} playlist={playlist} />
  );
  const { container, rerender } = render(ui(isOpen));
  return { user, onClose, onPlaylistUpdated, container, setOpen: (open: boolean) => rerender(ui(open)) };
}

/** 開いた状態で描画し、トラック一覧（曲A・曲B・曲C）の読み込みが終わるまで待つ */
async function renderLoadedModal() {
  const rendered = renderModal();
  await screen.findByRole("heading", { name: "現在のトラック (3曲)" });
  return rendered;
}

// タイトル・説明文の入力欄は <label> と関連付けられておらず placeholder もないため、ラベルの直後の要素として取得する
function fieldNextToLabel(labelText: string) {
  const field = screen.getByText(labelText, { selector: "label" }).nextElementSibling;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
    throw new Error(`「${labelText}」の入力欄が見つかりません`);
  }
  return field;
}
const titleInput = () => fieldNextToLabel("タイトル");
const descriptionInput = () => fieldNextToLabel("説明文");
const publicCheckbox = () => screen.getByRole("checkbox", { name: "公開プレイリストにする" });
const searchInput = () => screen.getByPlaceholderText("曲名、アーティスト名、アルバム名で検索");
const saveButton = () => screen.getByRole("button", { name: "プレイリスト情報を保存" });

/** 左の列（プレイリスト情報の編集・楽曲検索） */
const searchColumn = () => within(screen.getByRole("heading", { name: "楽曲を検索して追加" }).parentElement!);
/** 右の列（現在のトラック） */
const trackListColumn = () => within(screen.getByRole("heading", { name: /^現在のトラック/ }).parentElement!);

/** 「現在のトラック」に表示されている曲名を表示順に返す */
function displayedTrackNames() {
  return trackListColumn()
    .queryAllByText(/^曲[A-Z]$/)
    .map((element) => element.textContent);
}

/** 「現在のトラック」から、曲名で行（ドラッグできる要素）を取得する */
function trackRow(trackName: string) {
  const row = trackListColumn().getByText(trackName).closest<HTMLElement>('[draggable="true"]');
  if (!row) throw new Error(`「${trackName}」の行が見つかりません`);
  return row;
}

/** 検索語を入力して検索し、検索が終わる（ボタンが「検索中...」から戻る）まで待つ */
async function searchTracks(user: UserEvent, query = "追加したい曲") {
  await user.type(searchInput(), query);
  await user.click(screen.getByRole("button", { name: "検索" }));
  await screen.findByRole("button", { name: "検索" });
}

// jsdom は DataTransfer を実装していないため、ハンドラーが書き込むプロパティだけを持つオブジェクトで代用する
function createDataTransfer() {
  return { effectAllowed: "", dropEffect: "" };
}

/** from の行を to の行へドラッグ＆ドロップする */
function dragAndDrop(from: HTMLElement, to: HTMLElement) {
  const dataTransfer = createDataTransfer();
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
}

describe("EditPlaylistModal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fetchPlaylistItems).mockResolvedValue(
      playlistItems([{ track: trackA }, { track: trackB }, { track: trackC }]),
    );
    vi.mocked(searchSpotify).mockResolvedValue(searchResponse([trackD, trackE]));
    vi.mocked(addTracksToPlaylist).mockResolvedValue({});
    vi.mocked(removeTracksFromPlaylist).mockResolvedValue({});
    vi.mocked(reorderPlaylistTracks).mockResolvedValue({});
    vi.mocked(updatePlaylist).mockResolvedValue({});
    // jsdom は alert を実装していないため差し替える
    vi.spyOn(window, "alert").mockImplementation(() => {});
  });

  afterEach(() => {
    // Vitest の globals を有効にしていないので、Testing Library の自動クリーンアップは働かない
    cleanup();
    vi.restoreAllMocks();
  });

  describe("表示・読み込み", () => {
    it("isOpen が false のときは何も表示せず、トラックも読み込まない", () => {
      const { container } = renderModal({ isOpen: false });

      expect(container).toBeEmptyDOMElement();
      expect(fetchPlaylistItems).not.toHaveBeenCalled();
    });

    it("開くと、プレイリストの現在の情報を入力欄に表示する", () => {
      renderModal();

      expect(screen.getByRole("heading", { name: "プレイリストを編集: お気に入り" })).toBeInTheDocument();
      expect(titleInput()).toHaveValue("お気に入り");
      expect(descriptionInput()).toHaveValue(""); // 説明文は取得していないため、常に空から始まる
      expect(publicCheckbox()).toBeChecked();
    });

    it("読み込み中は「読み込み中...」を表示し、読み込んだトラックを番号付きで一覧表示する", async () => {
      renderModal();

      expect(fetchPlaylistItems).toHaveBeenCalledWith("playlist-1");
      expect(screen.getByText("読み込み中...")).toBeInTheDocument();

      expect(await screen.findByRole("heading", { name: "現在のトラック (3曲)" })).toBeInTheDocument();
      expect(screen.queryByText("読み込み中...")).not.toBeInTheDocument();
      expect(displayedTrackNames()).toEqual(["曲A", "曲B", "曲C"]);
      const rowB = within(trackRow("曲B"));
      expect(rowB.getByText("2")).toBeInTheDocument();
      expect(rowB.getByText("アーティストB")).toBeInTheDocument();
    });

    it("アルバム画像がある曲だけ画像を表示する", async () => {
      await renderLoadedModal();

      expect(within(trackRow("曲A")).getByRole("img", { name: "アルバムA" })).toHaveAttribute(
        "src",
        "https://example.com/album-a.jpg",
      );
      expect(within(trackRow("曲B")).queryByRole("img")).not.toBeInTheDocument();
    });

    it("曲の情報がない項目（track が null）は一覧に表示しない", async () => {
      vi.mocked(fetchPlaylistItems).mockResolvedValue(
        playlistItems([{ track: trackA }, { track: null }, { track: trackC }]),
      );
      renderModal();

      await waitForElementToBeRemoved(() => screen.queryByText("読み込み中..."));

      expect(displayedTrackNames()).toEqual(["曲A", "曲C"]);
    });

    it("トラックの読み込みに失敗しても「読み込み中...」のままにならない", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(fetchPlaylistItems).mockRejectedValue(new Error("500 Internal Server Error"));
      renderModal();

      await waitForElementToBeRemoved(() => screen.queryByText("読み込み中..."));

      expect(screen.getByRole("heading", { name: "現在のトラック (0曲)" })).toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith("トラック読み込みエラー:", expect.any(Error));
    });

    it("開き直すと、保存していない編集を破棄してプレイリスト情報とトラックを読み込み直す", async () => {
      const { user, setOpen } = await renderLoadedModal();
      await user.clear(titleInput());
      await user.type(titleInput(), "保存していないタイトル");
      vi.mocked(fetchPlaylistItems).mockResolvedValue(playlistItems([{ track: trackC }, { track: trackA }]));

      setOpen(false);
      setOpen(true);

      expect(titleInput()).toHaveValue("お気に入り");
      expect(fetchPlaylistItems).toHaveBeenCalledTimes(2);
      await screen.findByRole("heading", { name: "現在のトラック (2曲)" });
      expect(displayedTrackNames()).toEqual(["曲C", "曲A"]);
    });

    it.each(["×", "閉じる"])("「%s」ボタンで閉じると、検索語と検索結果をクリアする", async (buttonName) => {
      const { user, onClose } = await renderLoadedModal();
      await searchTracks(user);

      await user.click(screen.getByRole("button", { name: buttonName }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(searchInput()).toHaveValue("");
      expect(searchColumn().queryByText("曲D")).not.toBeInTheDocument();
    });
  });

  describe("プレイリスト情報の保存", () => {
    it("編集した内容で Spotify 上のプレイリスト情報を更新し、更新を通知する（モーダルは閉じない）", async () => {
      const { user, onClose, onPlaylistUpdated } = await renderLoadedModal();
      await user.clear(titleInput());
      await user.type(titleInput(), "通勤用");
      await user.type(descriptionInput(), "朝の電車で聴く曲");
      await user.click(publicCheckbox());

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistUpdated).toHaveBeenCalledTimes(1));
      expect(updatePlaylist).toHaveBeenCalledWith("playlist-1", {
        name: "通勤用",
        description: "朝の電車で聴く曲",
        public: false,
      });
      expect(window.alert).toHaveBeenCalledWith("プレイリスト情報を更新しました");
      expect(onClose).not.toHaveBeenCalled();
    });

    it("説明文が空なら description は undefined で送る", async () => {
      const { user, onPlaylistUpdated } = await renderLoadedModal();

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistUpdated).toHaveBeenCalledTimes(1));
      expect(updatePlaylist).toHaveBeenCalledWith("playlist-1", {
        name: "お気に入り",
        description: undefined,
        public: true,
      });
    });

    it("タイトルが空、または空白だけのときは保存ボタンを押せない", async () => {
      const { user } = await renderLoadedModal();
      expect(saveButton()).toBeEnabled();

      await user.clear(titleInput());
      expect(saveButton()).toBeDisabled();

      await user.type(titleInput(), "   ");
      expect(saveButton()).toBeDisabled();
    });

    it("保存中はボタンが「保存中...」になって押せない", async () => {
      const pending = deferred<unknown>();
      vi.mocked(updatePlaylist).mockReturnValue(pending.promise);
      const { user, onPlaylistUpdated } = await renderLoadedModal();

      await user.click(saveButton());

      expect(screen.getByRole("button", { name: "保存中..." })).toBeDisabled();
      pending.resolve({});
      expect(await screen.findByRole("button", { name: "プレイリスト情報を保存" })).toBeEnabled();
      expect(onPlaylistUpdated).toHaveBeenCalledTimes(1);
    });

    it("更新に失敗したらエラーを通知し、更新完了は通知しない", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(updatePlaylist).mockRejectedValue(new Error("403 Forbidden"));
      const { user, onPlaylistUpdated } = await renderLoadedModal();

      await user.click(saveButton());

      expect(await screen.findByRole("button", { name: "プレイリスト情報を保存" })).toBeEnabled();
      expect(window.alert).toHaveBeenCalledWith("プレイリストの更新に失敗しました");
      expect(consoleError).toHaveBeenCalledWith("プレイリスト更新エラー:", expect.any(Error));
      expect(onPlaylistUpdated).not.toHaveBeenCalled();
    });
  });

  describe("楽曲の検索", () => {
    it("検索ボタンで検索し、曲名・アーティスト・アルバムを結果に表示する", async () => {
      const { user } = await renderLoadedModal();
      await user.type(searchInput(), "追加したい曲");

      await user.click(screen.getByRole("button", { name: "検索" }));

      expect(searchSpotify).toHaveBeenCalledWith("追加したい曲");
      expect(await searchColumn().findByText("曲D")).toBeInTheDocument();
      expect(searchColumn().getByText("アーティストD • アルバムD")).toBeInTheDocument();
      expect(searchColumn().getByText("曲E")).toBeInTheDocument();
      expect(searchColumn().getAllByRole("button", { name: "追加" })).toHaveLength(2);
    });

    it("検索欄で Enter キーを押しても検索できる", async () => {
      const { user } = await renderLoadedModal();

      await user.type(searchInput(), "追加したい曲{Enter}");

      expect(searchSpotify).toHaveBeenCalledWith("追加したい曲");
      expect(await searchColumn().findByText("曲D")).toBeInTheDocument();
    });

    it("検索語が空白だけのときは検索しない", async () => {
      const { user } = await renderLoadedModal();
      const searchButton = screen.getByRole("button", { name: "検索" });
      expect(searchButton).toBeDisabled();

      await user.type(searchInput(), "   {Enter}");

      expect(searchButton).toBeDisabled();
      expect(searchSpotify).not.toHaveBeenCalled();
    });

    it("検索中はボタンが「検索中...」になって押せず、終わると元に戻る", async () => {
      const pending = deferred<ReturnType<typeof searchResponse>>();
      vi.mocked(searchSpotify).mockReturnValue(pending.promise);
      const { user } = await renderLoadedModal();
      await user.type(searchInput(), "追加したい曲");

      await user.click(screen.getByRole("button", { name: "検索" }));

      expect(screen.getByRole("button", { name: "検索中..." })).toBeDisabled();
      pending.resolve(searchResponse([trackD]));
      expect(await screen.findByRole("button", { name: "検索" })).toBeEnabled();
      expect(searchColumn().getByText("曲D")).toBeInTheDocument();
    });

    it("検索に失敗したらエラーを通知する", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(searchSpotify).mockRejectedValue(new Error("500 Internal Server Error"));
      const { user } = await renderLoadedModal();

      await searchTracks(user);

      expect(window.alert).toHaveBeenCalledWith("検索に失敗しました");
      expect(consoleError).toHaveBeenCalledWith("検索エラー:", expect.any(Error));
      expect(searchColumn().queryByRole("button", { name: "追加" })).not.toBeInTheDocument();
    });
  });

  describe("楽曲の追加", () => {
    it("検索結果の曲を Spotify 上のプレイリストに追加し、一覧の末尾に表示する", async () => {
      const { user } = await renderLoadedModal();
      await searchTracks(user);
      const [addD] = searchColumn().getAllByRole("button", { name: "追加" });

      await user.click(addD);

      expect(addTracksToPlaylist).toHaveBeenCalledWith("playlist-1", ["spotify:track:D"]);
      await screen.findByRole("heading", { name: "現在のトラック (4曲)" });
      expect(displayedTrackNames()).toEqual(["曲A", "曲B", "曲C", "曲D"]);
      expect(window.alert).toHaveBeenCalledWith("「曲D」を追加しました");
    });

    it("追加に失敗したらエラーを通知し、一覧は変えない", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(addTracksToPlaylist).mockRejectedValue(new Error("500 Internal Server Error"));
      const { user } = await renderLoadedModal();
      await searchTracks(user);
      const [addD] = searchColumn().getAllByRole("button", { name: "追加" });

      await user.click(addD);

      await waitFor(() => expect(window.alert).toHaveBeenCalledWith("トラックの追加に失敗しました"));
      expect(consoleError).toHaveBeenCalledWith("トラック追加エラー:", expect.any(Error));
      expect(displayedTrackNames()).toEqual(["曲A", "曲B", "曲C"]);
    });
  });

  describe("楽曲の削除", () => {
    it("確認のうえ Spotify 上のプレイリストから削除し、一覧からも取り除く", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { user } = await renderLoadedModal();

      await user.click(within(trackRow("曲B")).getByRole("button", { name: "削除" }));

      expect(window.confirm).toHaveBeenCalledWith("「曲B」を削除しますか？");
      expect(removeTracksFromPlaylist).toHaveBeenCalledWith("playlist-1", ["spotify:track:B"]);
      await screen.findByRole("heading", { name: "現在のトラック (2曲)" });
      expect(displayedTrackNames()).toEqual(["曲A", "曲C"]);
      expect(window.alert).toHaveBeenCalledWith("「曲B」を削除しました");
    });

    it("確認でキャンセルしたときは削除しない", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const { user } = await renderLoadedModal();

      await user.click(within(trackRow("曲B")).getByRole("button", { name: "削除" }));

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(removeTracksFromPlaylist).not.toHaveBeenCalled();
      expect(displayedTrackNames()).toEqual(["曲A", "曲B", "曲C"]);
    });

    it("削除に失敗したらエラーを通知し、一覧は変えない", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(removeTracksFromPlaylist).mockRejectedValue(new Error("500 Internal Server Error"));
      const { user } = await renderLoadedModal();

      await user.click(within(trackRow("曲B")).getByRole("button", { name: "削除" }));

      await waitFor(() => expect(window.alert).toHaveBeenCalledWith("トラックの削除に失敗しました"));
      expect(consoleError).toHaveBeenCalledWith("トラック削除エラー:", expect.any(Error));
      expect(displayedTrackNames()).toEqual(["曲A", "曲B", "曲C"]);
    });
  });

  describe("並び替え（ドラッグ＆ドロップ）", () => {
    it("ほかの行の上にドラッグすると、移動としてドロップを受け付ける", async () => {
      await renderLoadedModal();
      const dataTransfer = createDataTransfer();

      fireEvent.dragStart(trackRow("曲A"), { dataTransfer });
      // dragover で既定の動作を止めない（＝ fireEvent が true を返す）と、ブラウザはドロップを受け付けない
      const notCanceled = fireEvent.dragOver(trackRow("曲C"), { dataTransfer });

      expect(notCanceled).toBe(false);
      expect(dataTransfer).toEqual({ effectAllowed: "move", dropEffect: "move" });
    });

    it("下へ移動すると Spotify 上で並び替え、表示順も入れ替える", async () => {
      await renderLoadedModal();

      dragAndDrop(trackRow("曲A"), trackRow("曲C"));

      // 下へ移動するときは、ドロップ先の次の位置（insert_before = 3）を指定する
      expect(reorderPlaylistTracks).toHaveBeenCalledWith("playlist-1", 0, 3);
      await waitFor(() => expect(displayedTrackNames()).toEqual(["曲B", "曲C", "曲A"]));
    });

    it("上へ移動すると Spotify 上で並び替え、表示順も入れ替える", async () => {
      await renderLoadedModal();

      dragAndDrop(trackRow("曲C"), trackRow("曲A"));

      expect(reorderPlaylistTracks).toHaveBeenCalledWith("playlist-1", 2, 0);
      await waitFor(() => expect(displayedTrackNames()).toEqual(["曲C", "曲A", "曲B"]));
    });

    it("同じ行にドロップしたときは並び替えない", async () => {
      await renderLoadedModal();

      dragAndDrop(trackRow("曲B"), trackRow("曲B"));

      expect(reorderPlaylistTracks).not.toHaveBeenCalled();
      expect(displayedTrackNames()).toEqual(["曲A", "曲B", "曲C"]);
    });

    it("並び替えに失敗したらエラーを通知し、表示順は変えない", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(reorderPlaylistTracks).mockRejectedValue(new Error("500 Internal Server Error"));
      await renderLoadedModal();

      dragAndDrop(trackRow("曲A"), trackRow("曲C"));

      await waitFor(() => expect(window.alert).toHaveBeenCalledWith("並び替えに失敗しました"));
      expect(consoleError).toHaveBeenCalledWith("並び替えエラー:", expect.any(Error));
      expect(displayedTrackNames()).toEqual(["曲A", "曲B", "曲C"]);
    });
  });
});
