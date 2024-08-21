import { invoke, NTClass, NTMethod } from '../ntcall'
import { GeneralCallResult } from '../services'
import {
  CacheFileList,
  CacheFileListItem,
  CacheFileType,
  CacheScanResult,
  ChatCacheList,
  ChatCacheListItemBasic,
  ChatType,
  ElementType,
  IMAGE_HTTP_HOST,
  IMAGE_HTTP_HOST_NT,
  PicElement,
} from '../types'
import path from 'node:path'
import fs from 'node:fs'
import { ReceiveCmdS } from '../hook'
import { log, TEMP_DIR } from '@/common/utils'
import { rkeyManager } from '@/ntqqapi/api/rkey'
import { getSession } from '@/ntqqapi/wrapper'
import { Peer } from '@/ntqqapi/types/msg'
import { calculateFileMD5 } from '@/common/utils/file'
import { fileTypeFromFile } from 'file-type'
import fsPromise from 'node:fs/promises'
import { NTEventDispatch } from '@/common/utils/EventTask'
import { OnRichMediaDownloadCompleteParams } from '@/ntqqapi/listeners'
import { Time } from 'cosmokit'

export class NTQQFileApi {
  static async getVideoUrl(peer: Peer, msgId: string, elementId: string): Promise<string> {
    const session = getSession()
    return (await session?.getRichMediaService().getVideoPlayUrlV2(peer,
      msgId,
      elementId,
      0,
      { downSourceType: 1, triggerType: 1 }))?.urlResult?.domainUrl[0]?.url!
  }

  static async getFileType(filePath: string) {
    return fileTypeFromFile(filePath)
  }

  // 上传文件到QQ的文件夹
  static async uploadFile(filePath: string, elementType: ElementType = ElementType.PIC, elementSubType = 0) {
    const fileMd5 = await calculateFileMD5(filePath)
    let ext = (await NTQQFileApi.getFileType(filePath))?.ext || ''
    if (ext) {
      ext = '.' + ext
    }
    let fileName = `${path.basename(filePath)}`
    if (fileName.indexOf('.') === -1) {
      fileName += ext
    }
    const session = getSession()
    const mediaPath = session?.getMsgService().getRichMediaFilePathForGuild({
      md5HexStr: fileMd5,
      fileName: fileName,
      elementType: elementType,
      elementSubType,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: ''
    })
    await fsPromise.copyFile(filePath, mediaPath!)
    const fileSize = (await fsPromise.stat(filePath)).size
    return {
      md5: fileMd5,
      fileName,
      path: mediaPath!,
      fileSize,
      ext
    }
  }

  static async downloadMedia(
    msgId: string,
    chatType: ChatType,
    peerUid: string,
    elementId: string,
    thumbPath: string,
    sourcePath: string,
    timeout = 1000 * 60 * 2,
    force = false
  ) {
    // 用于下载收到的消息中的图片等
    if (sourcePath && fs.existsSync(sourcePath)) {
      if (force) {
        try {
          await fsPromise.unlink(sourcePath)
        } catch (e) {
          //
        }
      } else {
        return sourcePath
      }
    }
    const data = await NTEventDispatch.CallNormalEvent<
      (
        params: {
          fileModelId: string,
          downloadSourceType: number,
          triggerType: number,
          msgId: string,
          chatType: ChatType,
          peerUid: string,
          elementId: string,
          thumbSize: number,
          downloadType: number,
          filePath: string
        }) => Promise<unknown>,
      (fileTransNotifyInfo: OnRichMediaDownloadCompleteParams) => void
    >(
      'NodeIKernelMsgService/downloadRichMedia',
      'NodeIKernelMsgListener/onRichMediaDownloadComplete',
      1,
      timeout,
      (arg: OnRichMediaDownloadCompleteParams) => {
        if (arg.msgId === msgId) {
          return true
        }
        return false
      },
      {
        fileModelId: '0',
        downloadSourceType: 0,
        triggerType: 1,
        msgId: msgId,
        chatType: chatType,
        peerUid: peerUid,
        elementId: elementId,
        thumbSize: 0,
        downloadType: 1,
        filePath: thumbPath
      }
    )
    let filePath = data[1].filePath
    if (filePath.startsWith('\\')) {
      const downloadPath = TEMP_DIR
      filePath = path.join(downloadPath, filePath)
      // 下载路径是下载文件夹的相对路径
    }
    return filePath
  }

  static async getImageSize(filePath: string) {
    return await invoke<{ width: number; height: number }>({
      className: NTClass.FS_API,
      methodName: NTMethod.IMAGE_SIZE,
      args: [filePath],
    })
  }

  static async getImageUrl(element: PicElement) {
    if (!element) {
      return ''
    }
    const url: string = element.originImageUrl!  // 没有域名
    const md5HexStr = element.md5HexStr
    const fileMd5 = element.md5HexStr

    if (url) {
      const UrlParse = new URL(IMAGE_HTTP_HOST + url) //临时解析拼接
      const imageAppid = UrlParse.searchParams.get('appid')
      const isNewPic = imageAppid && ['1406', '1407'].includes(imageAppid)
      if (isNewPic) {
        let UrlRkey = UrlParse.searchParams.get('rkey')
        if (UrlRkey) {
          return IMAGE_HTTP_HOST_NT + url
        }
        const rkeyData = await rkeyManager.getRkey()
        UrlRkey = imageAppid === '1406' ? rkeyData.private_rkey : rkeyData.group_rkey
        return IMAGE_HTTP_HOST_NT + url + `${UrlRkey}`
      } else {
        // 老的图片url，不需要rkey
        return IMAGE_HTTP_HOST + url
      }
    } else if (fileMd5 || md5HexStr) {
      // 没有url，需要自己拼接
      return `${IMAGE_HTTP_HOST}/gchatpic_new/0/0-0-${(fileMd5 || md5HexStr)!.toUpperCase()}/0`
    }
    log('图片url获取失败', element)
    return ''
  }
}

export class NTQQFileCacheApi {
  static async setCacheSilentScan(isSilent: boolean = true) {
    return await invoke<GeneralCallResult>({
      methodName: NTMethod.CACHE_SET_SILENCE,
      args: [
        {
          isSilent,
        },
        null,
      ],
    })
  }

  static getCacheSessionPathList() {
    return invoke<
      {
        key: string
        value: string
      }[]
    >({
      className: NTClass.OS_API,
      methodName: NTMethod.CACHE_PATH_SESSION,
    })
  }

  static clearCache(cacheKeys: Array<string> = ['tmp', 'hotUpdate']) {
    return invoke<any>({
      // TODO: 目前还不知道真正的返回值是什么
      methodName: NTMethod.CACHE_CLEAR,
      args: [
        {
          keys: cacheKeys,
        },
        null,
      ],
    })
  }

  static addCacheScannedPaths(pathMap: object = {}) {
    return invoke<GeneralCallResult>({
      methodName: NTMethod.CACHE_ADD_SCANNED_PATH,
      args: [
        {
          pathMap: { ...pathMap },
        },
        null,
      ],
    })
  }

  static scanCache() {
    invoke<GeneralCallResult>({
      methodName: ReceiveCmdS.CACHE_SCAN_FINISH,
      classNameIsRegister: true,
    }).then()
    return invoke<CacheScanResult>({
      methodName: NTMethod.CACHE_SCAN,
      args: [null, null],
      timeout: 300 * Time.second,
    })
  }

  static getHotUpdateCachePath() {
    return invoke<string>({
      className: NTClass.HOTUPDATE_API,
      methodName: NTMethod.CACHE_PATH_HOT_UPDATE,
    })
  }

  static getDesktopTmpPath() {
    return invoke<string>({
      className: NTClass.BUSINESS_API,
      methodName: NTMethod.CACHE_PATH_DESKTOP_TEMP,
    })
  }

  static getChatCacheList(type: ChatType, pageSize: number = 1000, pageIndex: number = 0) {
    return new Promise<ChatCacheList>((res, rej) => {
      invoke<ChatCacheList>({
        methodName: NTMethod.CACHE_CHAT_GET,
        args: [
          {
            chatType: type,
            pageSize,
            order: 1,
            pageIndex,
          },
          null,
        ],
      })
        .then((list) => res(list))
        .catch((e) => rej(e))
    })
  }

  static getFileCacheInfo(fileType: CacheFileType, pageSize: number = 1000, lastRecord?: CacheFileListItem) {
    const _lastRecord = lastRecord ? lastRecord : { fileType: fileType }

    return invoke<CacheFileList>({
      methodName: NTMethod.CACHE_FILE_GET,
      args: [
        {
          fileType: fileType,
          restart: true,
          pageSize: pageSize,
          order: 1,
          lastRecord: _lastRecord,
        },
        null,
      ],
    })
  }

  static async clearChatCache(chats: ChatCacheListItemBasic[] = [], fileKeys: string[] = []) {
    return await invoke<GeneralCallResult>({
      methodName: NTMethod.CACHE_CHAT_CLEAR,
      args: [
        {
          chats,
          fileKeys,
        },
        null,
      ],
    })
  }
}
