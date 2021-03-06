const GH_RESERVED_USER_NAMES = [
  'settings', 'orgs', 'organizations',
  'site', 'blog', 'about', 'explore',
  'styleguide', 'showcases', 'trending',
  'stars', 'dashboard', 'notifications',
  'search', 'developer', 'account',
  'pulls', 'issues', 'features', 'contact',
  'security', 'join', 'login', 'watching',
  'new', 'integrations', 'gist', 'business',
  'mirrors', 'open-source', 'personal',
  'pricing'
]
const GH_RESERVED_REPO_NAMES = ['followers', 'following', 'repositories']
const GH_404_SEL = '#parallax_wrapper'
const GH_PJAX_CONTAINER_SEL = '#js-repo-pjax-container, .context-loader-container, [data-pjax-container]'
const GH_CONTAINERS = '.container, .container-responsive'
const GH_RAW_CONTENT = 'body > pre'

class Gitlab extends PjaxAdapter {

  constructor(store) {
    super(store)
  }

  // @override
  init($sidebar) {
    const pjaxContainer = $(GH_PJAX_CONTAINER_SEL)[0]
    super.init($sidebar, {'pjaxContainer': pjaxContainer})

    // Fix #151 by detecting when page layout is updated.
    // In this case, split-diff page has a wider layout, so need to recompute margin.
    // Note that couldn't do this in response to URL change, since new DOM via pjax might not be ready.
    const diffModeObserver = new window.MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (~mutation.oldValue.indexOf('split-diff') ||
          ~mutation.target.className.indexOf('split-diff')) {
          return $(document).trigger(EVENT.LAYOUT_CHANGE)
        }
      })
    })

    diffModeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true
    })
  }

  // @override
  _getCssClass() {
    return 'octotree_gitlab_sidebar'
  }

  // @override
  canLoadEntireTree() {
    return true
  }

  // @override
  getCreateTokenUrl() {
    return `${location.protocol}//${location.host}/settings/tokens/new`
  }

  // @override
  updateLayout(togglerVisible, sidebarVisible, sidebarWidth) {
    const SPACING = 10
    const $containers = $(GH_CONTAINERS)
    const autoMarginLeft = ($(document).width() - $containers.width()) / 2
    const shouldPushLeft = sidebarVisible && (autoMarginLeft <= sidebarWidth + SPACING)

    $('html').css('margin-left', shouldPushLeft ? sidebarWidth : '')
    $containers.css('margin-left', shouldPushLeft ? SPACING : '')
  }

  // @override
  getRepoFromPath(currentRepo, token, cb) {
    const showInNonCodePage = this.store.get(STORE.NONCODE)
    const showOnlyChangedInPR = this.store.get(STORE.PR)

    // 404 page, skip
    if ($(GH_404_SEL).length) {
      return cb()
    }

    // Skip raw page
    if ($(GH_RAW_CONTENT).length) {
      return cb()
    }

    // (username)/(reponame)[/(type)][/(typeId)]
    const match = window.location.pathname.match(/([^\/]+)\/([^\/]+)(?:\/([^\/]+))?(?:\/([^\/]+))?/)
    if (!match) {
      return cb()
    }

    let username = match[1]
    let reponame = match[2]
    let type = match[3]
    let typeId = match[4]

    // Not a repository, skip
    if (~GH_RESERVED_USER_NAMES.indexOf(username) ||
      ~GH_RESERVED_REPO_NAMES.indexOf(reponame)) {
      return cb()
    }

    // Check if this is a PR and whether we should show changes
    const isPR = type === 'pull'
    const pullNumber = isPR && showOnlyChangedInPR ? typeId : null

    // Skip non-code page unless showInNonCodePage is true
    if (!showInNonCodePage && type && !~['tree', 'blob'].indexOf(type)) {
      return cb()
    }
    // Get branch by inspecting page, quite fragile so provide multiple fallbacks
    const GL_BRANCH_SEL_1 = '#repository_ref'
    const GL_BRANCH_SEL_2 = '.select2-container.project-refs-select.select2 .select2-chosen'
    // .nav.nav-sidebar is for versions below 8.8
    const GL_BRANCH_SEL_3 = '.nav.nav-sidebar .shortcuts-tree, .nav-links .shortcuts-tree'

    const branch =
      // Code page
      $(GL_BRANCH_SEL_1).val() || $(GL_BRANCH_SEL_2).text() ||
      // Non-code page
      // A space ' ' is a failover to make match() always return an array
      ($(GL_BRANCH_SEL_3).attr('href') || ' ').match(/([^\/]+)/g)[3] ||
      // Assume same with previously
      (currentRepo.username === username && currentRepo.reponame === reponame && currentRepo.branch) ||
      // Default from cache
      this._defaultBranch[username + '/' + reponame]

    // Still no luck, get default branch for real
    const repo = {username: username, reponame: reponame, branch: branch, pullNumber: pullNumber}
    if (repo.branch) {
      cb(null, repo)
    }
    else {
      this._get(null, {repo, token}, (err, data) => {
        if (err) return cb(err)
        repo.branch = this._defaultBranch[username + '/' + reponame] = data.default_branch || 'master'
        cb(null, repo)
      })
    }
  }

  // @override
  selectFile(path) {
    const $pjaxContainer = $(GH_PJAX_CONTAINER_SEL)
    super.selectFile(path, {'$pjaxContainer': $pjaxContainer})
  }

  // @override
  loadCodeTree(opts, cb) {
    opts.encodedBranch = encodeURIComponent(decodeURIComponent(opts.repo.branch))
    opts.path = (opts.node && (opts.node.sha || opts.encodedBranch)) ||
      ('?ref=' + opts.encodedBranch + '&recursive=true&per_page=100')
    this._loadCodeTreeInternal(opts, null, cb)
  }

  // @override
  _getTree(path, opts, cb) {
    if (opts.repo.pullNumber) {
      this._getPatch(opts, cb)
    }
    else {
      this._get(`/repository/tree/${path}`, opts, (err, res) => {
        // console.log('****', res.tree);
        if (err) cb(err)
        // else cb(null, res.tree)
        else cb(null, res)
      })
    }
  }

  /**
   * Get files that were patched in Pull Request.
   * The diff map that is returned contains changed files, as well as the parents of the changed files.
   * This allows the tree to be filtered for only folders that contain files with diffs.
   * @param {Object} opts: {
   *                  path: the starting path to load the tree,
   *                  repo: the current repository,
   *                  node (optional): the selected node (null to load entire tree),
   *                  token (optional): the personal access token
   *                 }
   * @param {Function} cb(err: error, diffMap: Object)
   */
  _getPatch(opts, cb) {
    const {pullNumber} = opts.repo

    this._get(`/pulls/${pullNumber}/files?per_page=300`, opts, (err, res) => {
      if (err) cb(err)
      else {
        const diffMap = {}

        res.forEach((file, index) => {

          // record file patch info
          diffMap[file.filename] = {
            type: 'blob',
            diffId: index,
            action: file.status,
            additions: file.additions,
            blob_url: file.blob_url,
            deletions: file.deletions,
            filename: file.filename,
            path: file.path,
            sha: file.sha
          }

          // record ancestor folders
          const folderPath = file.filename.split('/').slice(0, -1).join('/')
          const split = folderPath.split('/')

          // aggregate metadata for ancestor folders
          split.reduce((path, curr) => {
            if (path.length) path = `${path}/${curr}`
            else path = `${curr}`

            if (diffMap[path] == null) {
              diffMap[path] = {
                type: 'tree',
                filename: path,
                filesChanged: 1,
                additions: file.additions,
                deletions: file.deletions
              }
            }
            else {
              diffMap[path].additions += file.additions
              diffMap[path].deletions += file.deletions
              diffMap[path].filesChanged++
            }
            return path
          }, '')
        })

        // transform to emulate response from get `tree`
        const tree = Object.keys(diffMap).map(fileName => {
          const patch = diffMap[fileName]
          return {
            patch,
            path: fileName,
            sha: patch.sha,
            type: patch.type,
            url: patch.blob_url,
          }
        })

        // sort by path, needs to be alphabetical order (so parent folders come before children)
        // note: this is still part of the above transform to mimic the behavior of get tree
        tree.sort((a, b) => a.path.localeCompare(b.path))

        cb(null, tree)
      }
    })
  }

  // @override
  _getSubmodules(tree, opts, cb) {
    const item = tree.filter((item) => /^\.gitmodules$/i.test(item.path))[0]
    if (!item) return cb()

    this._get(`/git/blobs/${item.sha}`, opts, (err, res) => {
      if (err) return cb(err)
      const data = atob(res.content.replace(/\n/g, ''))
      cb(null, parseGitmodules(data))
    })
  }

  _get(path, opts, cb) {
    const host = location.protocol + '//' + location.host
    const url = `${host}/api/v4/projects/${opts.repo.username}%2F${opts.repo.reponame}${path || ''}`
    const cfg = {url, method: 'GET', cache: false}

    if (opts.token) {
      cfg.headers = {Authorization: 'token ' + opts.token}
    }

    function loadAll(data0, xTotalPages) {
      let data_arr = [data0];
      let count = 1;
      for (let i = 2; i <= xTotalPages; i++) {
        cfg.data = {page: i}
        // cfg.async = false
        $.ajax(cfg)
          .done((data, textStatus, request) => {
            count++;
            if (path && path.indexOf('/git/trees') === 0 && data.truncated) {
              this._handleError({status: 206}, cb)
            } else {
              data_arr[i - 1] = data
              if (count == xTotalPages) {
                const merged = [].concat.apply([], data_arr)
                cb(null, merged)
              }
            }
          })
          .fail((jqXHR) => this._handleError(jqXHR, cb))
      }
    }

    $.ajax(cfg)
      .done((data, textStatus, request) => {
        if (path && path.indexOf('/git/trees') === 0 && data.truncated) {
          this._handleError({status: 206}, cb)
        }
        else {
          const xTotalPages = request.getResponseHeader('X-Total-Pages');
          if (xTotalPages > 1) {
            loadAll(data, xTotalPages);
            return
          }
          cb(null, data)
        }
      })
      .fail((jqXHR) => this._handleError(jqXHR, cb))
  }
}
