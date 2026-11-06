/**
 * EditPlaylistModal（既存のプレイリストを編集する画面）のテスト
 *
 * テストケースは「同値分割」と「境界値分析」で洗い出した。
 *   - isOpen .............. true（初期値を入れて曲を取得する） / false（何も表示しない）
 *   - 開いたときの初期値 .. playlist.name（1文字以上 / 空文字）、playlist.public（true / false）
 *   - 曲一覧の取得 ........ 成功 / 失敗 / 取得待ち
 *       曲数の境界値: 0曲 / 1曲 / 複数 / 100曲（1回で取得できる上限ちょうど）
 *       中身: 曲が null の項目、ジャケット画像（あり / なし）、アーティスト（1人 / 複数）
 *   - タイトル（前後の空白を除いた文字数）
 *       無効: 0文字（空・半角空白・全角空白・タブだけ）   有効: 1文字以上
 *       境界値: 0文字 / 1文字   極端な値: 10,000文字・記号・絵文字
 *   - 説明文 .............. 空（送らない） / 入力あり（そのまま送る）
 *   - 公開設定 ............ false→true / true→false
 *   - 削除する位置 ........ 先頭 / 中間 / 末尾、1曲だけ（1曲→0曲）、確認でキャンセル
 *   - 並び替え（ドラッグ元→ドロップ先、0始まりの位置）
 *       下へ（insert_before = ドロップ先 + 1） / 上へ（insert_before = ドロップ先）
 *       API を呼ばない: 同じ位置へのドロップ、行からドラッグしていないドロップ
 *       境界値: 隣への移動、先頭→末尾、末尾→先頭
 *   - API の結果（保存・検索・追加・削除・並び替え） .. 成功 / 失敗 / 応答待ち
 *
 * 外部への通信（../../api の関数）はすべてモックにしている。
 * 仕様が決まっていない点や、今の動きが本来と食い違って見える点は、今の動きを正としてテストで固めない。
 * それらは it.todo（仕様の確認待ち）と it.skip（不具合の疑い。skip を外すと今は失敗する）で残した。
 */
import "@testing-library/jest-dom/vitest"; // npm run build（tsc）でも jest-dom の型を使えるようにするため
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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
} from "../../api";
import EditPlaylistModal from "../EditPlaylistModal";
import {
  deferred,
  makePlaylist,
  makeTrack,
  makeTracks,
  parentOf,
  playlistItemsPage,
  rowOf,
  searchResponse,
} from "./testUtils";

// 外部への通信はすべてモックにする（api.ts の関数を差し替える）
vi.mock("../../api", () => ({
  fetchPlaylistItems: vi.fn(),
  searchSpotify: vi.fn(),
  addTracksToPlaylist: vi.fn(),
  removeTracksFromPlaylist: vi.fn(),
  reorderPlaylistTracks: vi.fn(),
  updatePlaylist: vi.fn(),
}));

const PLAYLIST: SpotifyPlaylist = makePlaylist({ id: "playlist-1", name: "ドライブ用", public: false });
const A = makeTrack("A");
const B = makeTrack("B");
const C = makeTrack("C");
const D = makeTrack("D");

let alertMock: Mock<(message?: unknown) => void>;
let confirmMock: Mock<(message?: string) => boolean>;
let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  vi.mocked(fetchPlaylistItems).mockResolvedValue(playlistItemsPage([A, B, C]));
  vi.mocked(searchSpotify).mockResolvedValue(searchResponse([]));
  vi.mocked(addTracksToPlaylist).mockResolvedValue({});
  vi.mocked(removeTracksFromPlaylist).mockResolvedValue({});
  vi.mocked(reorderPlaylistTracks).mockResolvedValue({});
  vi.mocked(updatePlaylist).mockResolvedValue({});
  alertMock = vi.fn<(message?: unknown) => void>();
  confirmMock = vi.fn<(message?: string) => boolean>(() => true);
  vi.stubGlobal("alert", alertMock);
  vi.stubGlobal("confirm", confirmMock);
  // 念のため、モック漏れで本当に通信しようとしたら分かるようにする
  fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error("テスト中に実際の通信をしようとしました")));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  const fetchCalls = fetchMock.mock.calls.length;
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  expect(fetchCalls, "実際の通信（fetch）が呼ばれた").toBe(0);
});

// ---------- テスト用の手順・部品 ----------

/** モックの API が返した Promise の続き（state の更新）を act の中で反映させる */
async function flushPromises() {
  await act(async () => {});
}

async function renderModal({
  isOpen = true,
  playlist = PLAYLIST,
  tracks,
}: { isOpen?: boolean; playlist?: SpotifyPlaylist; tracks?: (SpotifyTrack | null)[] } = {}) {
  if (tracks) vi.mocked(fetchPlaylistItems).mockResolvedValue(playlistItemsPage(tracks));
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onPlaylistUpdated = vi.fn();
  const ui = (open: boolean) => (
    <EditPlaylistModal isOpen={open} onClose={onClose} onPlaylistUpdated={onPlaylistUpdated} playlist={playlist} />
  );
  const view = render(ui(isOpen));
  await flushPromises();
  /** 親がいったん閉じて（isOpen=false）、また開いたときの状態にする */
  const reopen = async () => {
    view.rerender(ui(false));
    view.rerender(ui(true));
    await flushPromises();
  };
  return { user, onClose, onPlaylistUpdated, reopen, container: view.container };
}

/** ラベルと入力欄が結び付いていない（for / id が無い）ため、ラベルと同じ枠にある入力欄をたどって取る */
function fieldByLabel(text: string): HTMLElement {
  const label = screen.getByText(text, { selector: "label" });
  const field = parentOf(label).querySelector<HTMLElement>("input, textarea");
  if (!field) throw new Error(`「${text}」の入力欄が見つかりません`);
  return field;
}

const titleInput = () => fieldByLabel("タイトル");
const descriptionInput = () => fieldByLabel("説明文");
const publicCheckbox = () => screen.getByRole("checkbox", { name: "公開プレイリストにする" });
const saveButton = () => screen.getByText(/^(プレイリスト情報を保存|保存中\.\.\.)$/, { selector: "button" });
const searchInput = () => screen.getByPlaceholderText("曲名、アーティスト名、アルバム名で検索");
const searchButton = () => screen.getByText(/^検索(中\.\.\.)?$/, { selector: "button" });
const trackCountHeading = () => screen.getByText(/^現在のトラック/, { selector: "h3" });
/** 「現在のトラック」の各行（ドラッグできる行） */
const trackRows = () => Array.from(document.querySelectorAll<HTMLElement>('[draggable="true"]'));
const trackNames = () => trackRows().map((row) => within(row).getByText(/^Song /).textContent);
const rowNumbers = () => trackRows().map((row) => row.firstElementChild?.textContent);
const deleteButtonAt = (index: number) => within(trackRows()[index]).getByRole("button", { name: "削除" });
/** 検索結果の行にある「追加」ボタン（検索結果の曲名は一覧の曲名と重ならないようにしている） */
const addButtonFor = (track: SpotifyTrack) =>
  within(rowOf(screen.getByText(track.name))).getByRole("button", { name: "追加" });

/** 検索語を入れて「検索」を押し、検索が終わるまで待つ */
async function searchFor(user: UserEvent, query: string, results: SpotifyTrack[]) {
  vi.mocked(searchSpotify).mockResolvedValueOnce(searchResponse(results));
  await user.clear(searchInput());
  await user.type(searchInput(), query);
  await user.click(searchButton());
  await waitFor(() => expect(searchButton()).toHaveTextContent(/^検索$/));
}

/** ドラッグ中の行の背景色 */
const DRAGGING_STYLE = { backgroundColor: "#f0f0f0" };

/** ドラッグ＆ドロップの dataTransfer の代わり（jsdom には DataTransfer が無いため） */
function dataTransferStub() {
  return { effectAllowed: "uninitialized", dropEffect: "none" };
}

/** from 番目の行を to 番目の行へドラッグ＆ドロップする（0始まり） */
async function dragAndDrop(from: number, to: number) {
  const dataTransfer = dataTransferStub();
  fireEvent.dragStart(trackRows()[from], { dataTransfer });
  fireEvent.dragOver(trackRows()[to], { dataTransfer });
  await act(async () => {
    fireEvent.drop(trackRows()[to], { dataTransfer });
  });
}

// ---------- テスト ----------

describe("EditPlaylistModal", () => {
  describe("開閉（isOpen）と開いたときの初期値", () => {
    it("isOpen が false のときは何も表示せず、曲も取得しない", async () => {
      const { container } = await renderModal({ isOpen: false });

      expect(container).toBeEmptyDOMElement();
      expect(fetchPlaylistItems).not.toHaveBeenCalled();
    });

    it("開くと、見出しとタイトル欄に今の名前を入れ、そのプレイリストの曲を取得して表示する", async () => {
      await renderModal();

      expect(screen.getByRole("heading", { name: "プレイリストを編集: ドライブ用" })).toBeInTheDocument();
      expect(titleInput()).toHaveValue("ドライブ用");
      expect(saveButton()).toBeEnabled();
      expect(fetchPlaylistItems).toHaveBeenCalledTimes(1);
      expect(fetchPlaylistItems).toHaveBeenCalledWith("playlist-1");
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C"]);
      expect(trackCountHeading()).toHaveTextContent("現在のトラック (3曲)");
    });

    it.each([{ isPublic: true }, { isPublic: false }])(
      "公開設定のチェックは、開いたときの playlist.public（$isPublic）に合わせる",
      async ({ isPublic }) => {
        await renderModal({ playlist: makePlaylist({ public: isPublic }) });

        if (isPublic) expect(publicCheckbox()).toBeChecked();
        else expect(publicCheckbox()).not.toBeChecked();
      },
    );

    it("曲を取得している間は「読み込み中...」を表示し、取得できたら一覧に切り替える", async () => {
      const pending = deferred<Paging<SpotifyPlaylistItem>>();
      vi.mocked(fetchPlaylistItems).mockReturnValueOnce(pending.promise);
      await renderModal();

      expect(screen.getByText("読み込み中...")).toBeInTheDocument();
      expect(trackRows()).toHaveLength(0);

      await act(async () => pending.resolve(playlistItemsPage([A])));

      expect(screen.queryByText("読み込み中...")).not.toBeInTheDocument();
      expect(trackNames()).toEqual(["Song A"]);
    });

    it("名前が空文字のプレイリストを開くと、保存ボタンは押せない（初期値が0文字の境界）", async () => {
      await renderModal({ playlist: makePlaylist({ name: "" }) });

      expect(titleInput()).toHaveValue("");
      expect(saveButton()).toBeDisabled();
    });

    it("閉じて開き直すと、保存していないタイトル・公開設定の変更は捨て、曲を取得し直す", async () => {
      const { user, reopen } = await renderModal();
      await user.clear(titleInput());
      await user.type(titleInput(), "保存しない名前");
      await user.click(publicCheckbox());

      await reopen();

      expect(titleInput()).toHaveValue("ドライブ用");
      expect(publicCheckbox()).not.toBeChecked();
      expect(fetchPlaylistItems).toHaveBeenCalledTimes(2);
      expect(updatePlaylist).not.toHaveBeenCalled();
    });
  });

  describe("曲一覧の表示", () => {
    it("0曲のプレイリストは「(0曲)」と表示し、行を出さない", async () => {
      await renderModal({ tracks: [] });

      expect(trackCountHeading()).toHaveTextContent("現在のトラック (0曲)");
      expect(trackRows()).toHaveLength(0);
    });

    it("1曲のプレイリストは「(1曲)」と表示し、番号1・曲名・アーティストを出す", async () => {
      await renderModal({ tracks: [A] });

      expect(trackCountHeading()).toHaveTextContent("現在のトラック (1曲)");
      expect(rowNumbers()).toEqual(["1"]);
      expect(within(trackRows()[0]).getByText("Song A")).toBeInTheDocument();
      expect(within(trackRows()[0]).getByText("Artist A")).toBeInTheDocument();
      expect(within(trackRows()[0]).getByRole("button", { name: "削除" })).toBeInTheDocument();
    });

    it("複数の曲は、取得した順に1から番号を振って表示する", async () => {
      await renderModal({ tracks: [C, A, B] });

      expect(trackNames()).toEqual(["Song C", "Song A", "Song B"]);
      expect(rowNumbers()).toEqual(["1", "2", "3"]);
    });

    it("100曲（1回で取得できる上限ちょうど）のプレイリストは、100曲すべてを表示する", async () => {
      const tracks = makeTracks(100);
      await renderModal({ tracks });

      expect(trackCountHeading()).toHaveTextContent("現在のトラック (100曲)");
      expect(trackRows()).toHaveLength(100);
      expect(rowNumbers()[0]).toBe("1");
      expect(rowNumbers()[99]).toBe("100");
      expect(trackNames()[99]).toBe("Song 100");
    });

    it("ジャケット画像があれば先頭の画像を出し、無ければ画像を出さない", async () => {
      const withImages = makeTrack("A", {
        album: {
          id: "album-a",
          name: "Album A",
          images: [
            { url: "https://example.com/a-640.jpg", width: 640, height: 640 },
            { url: "https://example.com/a-64.jpg", width: 64, height: 64 },
          ],
        },
      });
      const withoutImages = makeTrack("B");
      await renderModal({ tracks: [withImages, withoutImages] });

      const [rowWithImages, rowWithoutImages] = trackRows();
      expect(within(rowWithImages).getByRole("img", { name: "Album A" })).toHaveAttribute(
        "src",
        "https://example.com/a-640.jpg",
      );
      expect(within(rowWithoutImages).queryByRole("img")).not.toBeInTheDocument();
    });

    it("アーティストが複数いる曲は「, 」区切りで表示する", async () => {
      const multi = makeTrack("A", {
        artists: [
          { id: "a1", name: "Artist A1" },
          { id: "a2", name: "Artist A2" },
          { id: "a3", name: "Artist A3" },
        ],
      });
      await renderModal({ tracks: [multi] });

      expect(within(trackRows()[0]).getByText("Artist A1, Artist A2, Artist A3")).toBeInTheDocument();
    });

    it("曲が null の項目（ローカルファイルなど）は表示せず、前後の曲は表示する", async () => {
      await renderModal({ tracks: [A, null, B] });

      // 件数の表示と番号の振り方（null の項目を数えるか）は仕様の確認待ちのため確かめない
      expect(trackNames()).toEqual(["Song A", "Song B"]);
    });

    it("曲の取得に失敗しても「読み込み中...」のまま止まらない", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(fetchPlaylistItems).mockRejectedValueOnce(new Error("500 Internal Server Error"));

      await renderModal();

      // 失敗したことをどう知らせるか（今は知らせずに「0曲」と表示する）は食い違いとして報告し、ここでは確かめない
      expect(screen.queryByText("読み込み中...")).not.toBeInTheDocument();
      expect(errorSpy).toHaveBeenCalledWith("トラック読み込みエラー:", expect.any(Error));
    });
  });

  describe("プレイリスト情報の保存", () => {
    it("タイトルを変えて保存すると、そのタイトル・説明なし・今の公開設定で更新し、完了を知らせる", async () => {
      const { user, onPlaylistUpdated } = await renderModal();
      await user.clear(titleInput());
      await user.type(titleInput(), "新しい名前");

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistUpdated).toHaveBeenCalledTimes(1));
      expect(updatePlaylist).toHaveBeenCalledTimes(1);
      // 説明文の扱いは、下の説明文のテストで確かめる
      expect(updatePlaylist).toHaveBeenCalledWith(
        "playlist-1",
        expect.objectContaining({ name: "新しい名前", public: false }),
      );
      expect(alertMock).toHaveBeenCalledWith("プレイリスト情報を更新しました");
    });

    it.each([
      { label: "半角空白1文字", value: " " },
      { label: "半角空白3文字", value: "   " },
      { label: "全角空白1文字", value: "　" },
      { label: "タブ1文字", value: "\t" },
    ])("タイトルを空白だけ（$label）にすると保存ボタンが押せない", async ({ value }) => {
      const { user } = await renderModal();

      await user.clear(titleInput());
      await user.paste(value);

      expect(titleInput()).toHaveValue(value);
      expect(saveButton()).toBeDisabled();
    });

    it("タイトルを全部消す（0文字）と保存ボタンが押せず、1文字入れると押せる", async () => {
      const { user } = await renderModal();

      await user.clear(titleInput());
      expect(saveButton()).toBeDisabled();

      await user.type(titleInput(), "a");
      expect(saveButton()).toBeEnabled();
    });

    it("前後に空白があるタイトルでも、保存ボタンは押せる", async () => {
      const { user } = await renderModal();

      await user.clear(titleInput());
      await user.paste("  a  ");

      // 前後の空白を除いて送るかどうかは仕様の確認待ちのため、送る内容は確かめない
      expect(saveButton()).toBeEnabled();
    });

    it.each([
      // 文字数の上限は仕様の確認待ち（今は画面側で制限していない）。上限を決めたらこのケースを見直す
      { label: "10,000文字", value: "あ".repeat(10_000) },
      { label: "記号や HTML のような文字列", value: `<b>"Rock" & 'Roll'</b> #1 100%` },
      { label: "絵文字だけ", value: "🎵🎸🥁" },
    ])("タイトルが$label でも、変えずにそのまま送る", async ({ value }) => {
      const { user, onPlaylistUpdated } = await renderModal();
      await user.clear(titleInput());
      await user.paste(value);

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistUpdated).toHaveBeenCalledTimes(1));
      expect(updatePlaylist).toHaveBeenCalledWith("playlist-1", expect.objectContaining({ name: value }));
    });

    it("説明文を入れると、その説明文を送る", async () => {
      const { user, onPlaylistUpdated } = await renderModal();
      await user.type(descriptionInput(), "夜のドライブで聴く曲");

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistUpdated).toHaveBeenCalledTimes(1));
      expect(updatePlaylist).toHaveBeenCalledWith("playlist-1", {
        name: "ドライブ用",
        description: "夜のドライブで聴く曲",
        public: false,
      });
    });

    // 今の画面は開いたときに今の説明文を読み込まない（常に空欄）。そのため「空欄なら送らない」でないと、
    // タイトルを変えて保存するたびに説明文が消えてしまう。説明文を読み込むように直すなら、このテストも見直す。
    it("説明文を入れてから消す（1文字→0文字）と、description は送らない（今ある説明文を空で上書きしない）", async () => {
      const { user, onPlaylistUpdated } = await renderModal();
      await user.type(descriptionInput(), "a");
      await user.clear(descriptionInput());

      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistUpdated).toHaveBeenCalledTimes(1));
      expect(vi.mocked(updatePlaylist).mock.calls[0][1].description).toBeUndefined();
    });

    it.each([
      { initial: false, sent: true },
      { initial: true, sent: false },
    ])("公開設定を切り替えて保存すると、初期値 $initial から切り替えた public: $sent を送る", async ({ initial, sent }) => {
      const { user, onPlaylistUpdated } = await renderModal({ playlist: makePlaylist({ public: initial }) });

      await user.click(publicCheckbox());
      await user.click(saveButton());

      await waitFor(() => expect(onPlaylistUpdated).toHaveBeenCalledTimes(1));
      expect(updatePlaylist).toHaveBeenCalledWith("playlist-1", expect.objectContaining({ public: sent }));
    });

    it("保存中は「保存中...」と表示してボタンを押せなくし、もう一度押しても二重に保存しない", async () => {
      const pending = deferred<unknown>();
      vi.mocked(updatePlaylist).mockReturnValueOnce(pending.promise);
      const { user, onPlaylistUpdated } = await renderModal();

      await user.click(saveButton());

      expect(saveButton()).toHaveTextContent("保存中...");
      expect(saveButton()).toBeDisabled();
      await user.click(saveButton());
      expect(updatePlaylist).toHaveBeenCalledTimes(1);

      await act(async () => pending.resolve({}));

      expect(onPlaylistUpdated).toHaveBeenCalledTimes(1);
      expect(saveButton()).toHaveTextContent("プレイリスト情報を保存");
      expect(saveButton()).toBeEnabled();
    });

    it("保存に失敗したら「プレイリストの更新に失敗しました」と知らせ、更新の通知（onPlaylistUpdated）はしない", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(updatePlaylist).mockRejectedValueOnce(new Error("500 Internal Server Error"));
      const { user, onPlaylistUpdated } = await renderModal();

      await user.click(saveButton());

      await waitFor(() => expect(alertMock).toHaveBeenCalledWith("プレイリストの更新に失敗しました"));
      await waitFor(() => expect(saveButton()).toHaveTextContent("プレイリスト情報を保存"));
      expect(saveButton()).toBeEnabled();
      expect(onPlaylistUpdated).not.toHaveBeenCalled();
      expect(alertMock).not.toHaveBeenCalledWith("プレイリスト情報を更新しました");
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe("曲の検索", () => {
    it.each([
      { label: "未入力（0文字）", value: "" },
      { label: "半角空白だけ", value: "   " },
      { label: "全角空白だけ", value: "　" },
    ])("検索語が$label のときは検索ボタンが押せず、Enter でも検索しない", async ({ value }) => {
      const { user } = await renderModal();

      await user.click(searchInput());
      if (value) await user.paste(value);

      expect(searchButton()).toBeDisabled();
      await user.keyboard("{Enter}");
      expect(searchSpotify).not.toHaveBeenCalled();
    });

    it("1文字（下限）の検索語で検索でき、Enter 以外のキー入力では検索しない", async () => {
      const { user } = await renderModal();

      await user.type(searchInput(), "a");
      expect(searchButton()).toBeEnabled();
      expect(searchSpotify).not.toHaveBeenCalled();

      await user.keyboard("{Enter}");

      await waitFor(() => expect(searchButton()).toHaveTextContent(/^検索$/));
      expect(searchSpotify).toHaveBeenCalledTimes(1);
      expect(searchSpotify).toHaveBeenCalledWith("a");
    });

    it("検索結果には、曲名・アーティスト（複数は「, 」区切り）・アルバム名と「追加」ボタンを出す", async () => {
      const result = makeTrack("S1", {
        artists: [
          { id: "s1a", name: "Artist S1a" },
          { id: "s1b", name: "Artist S1b" },
        ],
      });
      const { user } = await renderModal();

      await searchFor(user, "new song", [result]);

      expect(searchSpotify).toHaveBeenCalledWith("new song");
      const row = rowOf(screen.getByText("Song S1"));
      expect(within(row).getByText("Artist S1a, Artist S1b • Album S1")).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: "追加" })).toBeEnabled();
    });

    it("検索中は「検索中...」と表示してボタンを押せなくし、終わると元に戻る", async () => {
      const pending = deferred<ReturnType<typeof searchResponse>>();
      vi.mocked(searchSpotify).mockReturnValueOnce(pending.promise);
      const { user } = await renderModal();
      await user.type(searchInput(), "beatles");

      await user.click(searchButton());

      expect(searchButton()).toHaveTextContent("検索中...");
      expect(searchButton()).toBeDisabled();

      await act(async () => pending.resolve(searchResponse([makeTrack("S1")])));

      expect(searchButton()).toHaveTextContent(/^検索$/);
      expect(screen.getByText("Song S1")).toBeInTheDocument();
    });

    it("検索結果が0件のときは、結果の一覧（「追加」ボタン）を表示しない", async () => {
      const { user } = await renderModal();

      await searchFor(user, "該当なし", []);

      expect(searchSpotify).toHaveBeenCalledWith("該当なし");
      expect(screen.queryByRole("button", { name: "追加" })).not.toBeInTheDocument();
    });

    it("検索に失敗したら「検索に失敗しました」と知らせ、ボタンを元に戻す", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(searchSpotify).mockRejectedValueOnce(new Error("500 Internal Server Error"));
      const { user } = await renderModal();
      await user.type(searchInput(), "beatles");

      await user.click(searchButton());

      await waitFor(() => expect(alertMock).toHaveBeenCalledWith("検索に失敗しました"));
      await waitFor(() => expect(searchButton()).toHaveTextContent(/^検索$/));
      expect(errorSpy).toHaveBeenCalled();
    });

    // 最終報告「4. 食い違って見える点」を参照。skip を外すと今は失敗する（検索APIが2回呼ばれる）
    it.skip("【不具合の疑い】検索中は Enter キーでも検索し直さない（ボタンを押せないのと揃える）", async () => {
      const pending = deferred<ReturnType<typeof searchResponse>>();
      vi.mocked(searchSpotify).mockReturnValueOnce(pending.promise);
      const { user } = await renderModal();
      await user.type(searchInput(), "beatles{Enter}");
      expect(searchButton()).toHaveTextContent("検索中...");

      await user.keyboard("{Enter}");

      expect(searchSpotify).toHaveBeenCalledTimes(1);
      await act(async () => pending.resolve(searchResponse([])));
    });
  });

  describe("曲の追加", () => {
    it("検索結果の「追加」を押すとこのプレイリストに追加し、一覧の末尾に足して完了を知らせる", async () => {
      const s1 = makeTrack("S1");
      const { user } = await renderModal();
      await searchFor(user, "new song", [s1]);

      await user.click(addButtonFor(s1));

      await waitFor(() => expect(trackNames()).toEqual(["Song A", "Song B", "Song C", "Song S1"]));
      expect(addTracksToPlaylist).toHaveBeenCalledTimes(1);
      expect(addTracksToPlaylist).toHaveBeenCalledWith("playlist-1", [s1.uri]);
      expect(rowNumbers()).toEqual(["1", "2", "3", "4"]);
      expect(trackCountHeading()).toHaveTextContent("現在のトラック (4曲)");
      expect(alertMock).toHaveBeenCalledWith("「Song S1」を追加しました");
    });

    it("0曲のプレイリストに追加すると1曲になる（0曲→1曲の境界）", async () => {
      const s1 = makeTrack("S1");
      const { user } = await renderModal({ tracks: [] });
      await searchFor(user, "new song", [s1]);

      await user.click(addButtonFor(s1));

      await waitFor(() => expect(trackNames()).toEqual(["Song S1"]));
      expect(rowNumbers()).toEqual(["1"]);
      expect(trackCountHeading()).toHaveTextContent("現在のトラック (1曲)");
    });

    it("追加に失敗したら「トラックの追加に失敗しました」と知らせ、一覧は変えない", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(addTracksToPlaylist).mockRejectedValueOnce(new Error("500 Internal Server Error"));
      const s1 = makeTrack("S1");
      const { user } = await renderModal();
      await searchFor(user, "new song", [s1]);

      await user.click(addButtonFor(s1));

      await waitFor(() => expect(alertMock).toHaveBeenCalledWith("トラックの追加に失敗しました"));
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C"]);
      expect(trackCountHeading()).toHaveTextContent("現在のトラック (3曲)");
      expect(alertMock).not.toHaveBeenCalledWith("「Song S1」を追加しました");
      expect(errorSpy).toHaveBeenCalled();
    });

    // 最終報告「4. 食い違って見える点」を参照。skip を外すと今は失敗する（一覧が A, B, C, S2 になり S1 が消える）
    it.skip("【不具合の疑い】前の追加の応答を待っている間に別の曲を追加しても、両方とも一覧に残る", async () => {
      const s1 = makeTrack("S1");
      const s2 = makeTrack("S2");
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      vi.mocked(addTracksToPlaylist).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      const { user } = await renderModal();
      await searchFor(user, "new song", [s1, s2]);

      await user.click(addButtonFor(s1));
      await user.click(addButtonFor(s2));
      await act(async () => first.resolve({}));
      await act(async () => second.resolve({}));

      expect(addTracksToPlaylist).toHaveBeenCalledTimes(2);
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C", "Song S1", "Song S2"]);
    });
  });

  describe("曲の削除", () => {
    it("確認でキャンセルすると削除APIを呼ばず、一覧も変えない", async () => {
      confirmMock.mockReturnValueOnce(false);
      const { user } = await renderModal();

      await user.click(deleteButtonAt(1));

      expect(confirmMock).toHaveBeenCalledWith("「Song B」を削除しますか？");
      expect(removeTracksFromPlaylist).not.toHaveBeenCalled();
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C"]);
      expect(alertMock).not.toHaveBeenCalled();
    });

    it.each([
      { label: "先頭", index: 0, track: A, rest: ["Song B", "Song C"] },
      { label: "中間", index: 1, track: B, rest: ["Song A", "Song C"] },
      { label: "末尾", index: 2, track: C, rest: ["Song A", "Song B"] },
    ])("$label の曲を削除すると、その曲の URI で削除し、一覧から外して番号を振り直す", async ({ index, track, rest }) => {
      const { user } = await renderModal();

      await user.click(deleteButtonAt(index));

      await waitFor(() => expect(trackNames()).toEqual(rest));
      expect(confirmMock).toHaveBeenCalledWith(`「${track.name}」を削除しますか？`);
      expect(removeTracksFromPlaylist).toHaveBeenCalledTimes(1);
      expect(removeTracksFromPlaylist).toHaveBeenCalledWith("playlist-1", [track.uri]);
      expect(rowNumbers()).toEqual(["1", "2"]);
      expect(trackCountHeading()).toHaveTextContent("現在のトラック (2曲)");
      expect(alertMock).toHaveBeenCalledWith(`「${track.name}」を削除しました`);
    });

    it("1曲だけのプレイリストで削除すると0曲になる（1曲→0曲の境界）", async () => {
      const { user } = await renderModal({ tracks: [A] });

      await user.click(deleteButtonAt(0));

      await waitFor(() => expect(trackRows()).toHaveLength(0));
      expect(trackCountHeading()).toHaveTextContent("現在のトラック (0曲)");
      expect(removeTracksFromPlaylist).toHaveBeenCalledWith("playlist-1", [A.uri]);
    });

    it("削除に失敗したら「トラックの削除に失敗しました」と知らせ、一覧は変えない", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(removeTracksFromPlaylist).mockRejectedValueOnce(new Error("400 Bad Request"));
      const { user } = await renderModal();

      await user.click(deleteButtonAt(0));

      await waitFor(() => expect(alertMock).toHaveBeenCalledWith("トラックの削除に失敗しました"));
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C"]);
      expect(alertMock).not.toHaveBeenCalledWith("「Song A」を削除しました");
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe("並び替え（ドラッグ＆ドロップ）", () => {
    it.each([
      { label: "下へ隣に", from: 0, to: 1, insertBefore: 2, order: ["Song B", "Song A", "Song C", "Song D"] },
      { label: "上へ隣に", from: 1, to: 0, insertBefore: 0, order: ["Song B", "Song A", "Song C", "Song D"] },
      { label: "先頭から末尾へ", from: 0, to: 3, insertBefore: 4, order: ["Song B", "Song C", "Song D", "Song A"] },
      { label: "末尾から先頭へ", from: 3, to: 0, insertBefore: 0, order: ["Song D", "Song A", "Song B", "Song C"] },
      { label: "途中で下へ", from: 1, to: 2, insertBefore: 3, order: ["Song A", "Song C", "Song B", "Song D"] },
      { label: "途中で上へ", from: 2, to: 1, insertBefore: 1, order: ["Song A", "Song C", "Song B", "Song D"] },
    ])(
      "$label（位置 $from → $to）動かすと range_start=$from, insert_before=$insertBefore で並び替え、一覧も同じ順になる",
      async ({ from, to, insertBefore, order }) => {
        await renderModal({ tracks: [A, B, C, D] });

        await dragAndDrop(from, to);

        expect(reorderPlaylistTracks).toHaveBeenCalledTimes(1);
        expect(reorderPlaylistTracks).toHaveBeenCalledWith("playlist-1", from, insertBefore);
        expect(trackNames()).toEqual(order);
        expect(rowNumbers()).toEqual(["1", "2", "3", "4"]);
      },
    );

    it("同じ行にドロップしたときは並び替えAPIを呼ばず、順番も変えない", async () => {
      await renderModal({ tracks: [A, B, C, D] });

      await dragAndDrop(1, 1);

      expect(reorderPlaylistTracks).not.toHaveBeenCalled();
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C", "Song D"]);
    });

    it("行からドラッグを始めずにドロップされたとき（画面の外から持ち込まれたなど）は並び替えAPIを呼ばない", async () => {
      await renderModal({ tracks: [A, B, C, D] });

      await act(async () => {
        fireEvent.drop(trackRows()[2], { dataTransfer: dataTransferStub() });
      });

      expect(reorderPlaylistTracks).not.toHaveBeenCalled();
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C", "Song D"]);
    });

    it("並び替えに失敗したら「並び替えに失敗しました」と知らせ、順番は変えない", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(reorderPlaylistTracks).mockRejectedValueOnce(new Error("500 Internal Server Error"));
      await renderModal({ tracks: [A, B, C, D] });

      await dragAndDrop(0, 3);

      expect(alertMock).toHaveBeenCalledWith("並び替えに失敗しました");
      expect(trackNames()).toEqual(["Song A", "Song B", "Song C", "Song D"]);
      expect(errorSpy).toHaveBeenCalled();
    });

    it("ドラッグ中の行は背景色で示し、ドロップすると元に戻す", async () => {
      await renderModal({ tracks: [A, B, C, D] });
      const dataTransfer = dataTransferStub();

      fireEvent.dragStart(trackRows()[1], { dataTransfer });

      expect(trackRows()[1]).toHaveStyle(DRAGGING_STYLE);
      expect(trackRows()[0]).not.toHaveStyle(DRAGGING_STYLE);

      await act(async () => {
        fireEvent.drop(trackRows()[3], { dataTransfer });
      });

      for (const row of trackRows()) {
        expect(row).not.toHaveStyle(DRAGGING_STYLE);
      }
    });

    it("ドラッグ開始で effectAllowed を move にし、ドラッグオーバーでドロップを受け付ける（preventDefault・dropEffect を move）", async () => {
      await renderModal({ tracks: [A, B] });
      const dataTransfer = dataTransferStub();

      fireEvent.dragStart(trackRows()[0], { dataTransfer });
      const notCanceled = fireEvent.dragOver(trackRows()[1], { dataTransfer });

      expect(dataTransfer.effectAllowed).toBe("move");
      expect(notCanceled).toBe(false); // preventDefault されている（＝ドロップを受け付ける）
      expect(dataTransfer.dropEffect).toBe("move");
    });

    // 最終報告「4. 食い違って見える点」を参照。skip を外すと今は失敗する（背景色が #f0f0f0 のまま残る）
    it.skip("【不具合の疑い】行の外でドラッグをやめたとき（dragend）も、ドラッグ中の背景色を元に戻す", async () => {
      await renderModal({ tracks: [A, B, C] });
      const dataTransfer = dataTransferStub();

      fireEvent.dragStart(trackRows()[0], { dataTransfer });
      expect(trackRows()[0]).toHaveStyle(DRAGGING_STYLE);

      fireEvent.dragEnd(trackRows()[0], { dataTransfer });

      expect(trackRows()[0]).not.toHaveStyle(DRAGGING_STYLE);
    });
  });

  describe("閉じる", () => {
    it.each([{ button: "×" }, { button: "閉じる" }])(
      "「$button」で閉じると onClose を1回だけ呼び、保存はしない。開き直すと検索語と検索結果は消えている",
      async ({ button }) => {
        const { user, onClose, onPlaylistUpdated, reopen } = await renderModal();
        await searchFor(user, "new song", [makeTrack("S1")]);
        expect(screen.getByText("Song S1")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: button }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(updatePlaylist).not.toHaveBeenCalled();
        expect(onPlaylistUpdated).not.toHaveBeenCalled();

        await reopen();

        expect(searchInput()).toHaveValue("");
        expect(screen.queryByText("Song S1")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "追加" })).not.toBeInTheDocument();
      },
    );
  });

  // 仕様が決まっていないため、今の動きを正としてテストにしていない点（最終報告「3」「4」を参照）
  describe("仕様の確認が要る点", () => {
    it.todo("今の説明文を表示するか・空にして説明文を消せるようにするか（今は毎回空欄で始まり、空欄なら送らない）");
    it.todo("101曲以上のプレイリスト（今は先頭100曲だけを表示し、件数も「100曲」になる）");
    it.todo("曲の読み込みに失敗したときの表示（今は何も知らせず「0曲」と表示する）");
    it.todo("曲が null の項目を件数・番号に含めるか（今は件数に含め、番号は飛ぶ）");
    it.todo("同じ曲を重複して追加できてよいか（作成画面では重複できない）");
    it.todo("同じ曲が複数あるとき1つだけ削除すると、Spotify 側では同じ曲がすべて消える点の扱い");
    it.todo("タイトルの前後の空白を取り除いて送るか・文字数の上限（作成画面と同じ）");
  });
});
