/**
 * Copyright (c) Baidu Inc. All rights reserved.
 *
 * This source code is licensed under the MIT license.
 * See LICENSE file in the project root for license information.
 *
 * @file for 指令节点类
 */

var inherits = require('../util/inherits');
var each = require('../util/each');
var guid = require('../util/guid');
var ExprType = require('../parser/expr-type');
var parseExpr = require('../parser/parse-expr');
var createAccessor = require('../parser/create-accessor');
var Data = require('../runtime/data');
var DataChangeType = require('../runtime/data-change-type');
var changeExprCompare = require('../runtime/change-expr-compare');
var evalExpr = require('../runtime/eval-expr');
var changesIsInDataRef = require('../runtime/changes-is-in-data-ref');
var insertBefore = require('../browser/insert-before');
var NodeType = require('./node-type');
var createNode = require('./create-node');
var createReverseNode = require('./create-reverse-node');
var nodeOwnSimpleDispose = require('./node-own-simple-dispose');
var nodeOwnCreateStump = require('./node-own-create-stump');
var dataCache = require('../runtime/data-cache');


/**
 * 循环项的数据容器类
 *
 * @inner
 * @class
 * @param {Object} forElement for元素对象
 * @param {*} item 当前项的数据
 * @param {number} index 当前项的索引
 */
function ForItemData(forElement, item, index) {
    this.id = guid();
    this.parent = forElement.scope;
    this.raw = {};
    this.listeners = [];

    this.directive = forElement.aNode.directives['for']; // eslint-disable-line dot-notation
    this.indexName = this.directive.index || '$index';

    this.raw[this.directive.item] = item;
    this.raw[this.indexName] = index;
}

/**
 * 将数据操作的表达式，转换成为对parent数据操作的表达式
 * 主要是对item和index进行处理
 *
 * @param {Object} expr 表达式
 * @return {Object}
 */
ForItemData.prototype.exprResolve = function (expr) {
    var me = this;
    var directive = this.directive;

    function resolveItem(expr) {
        if (expr.type === ExprType.ACCESSOR && expr.paths[0].value === directive.item) {
            return createAccessor(
                directive.value.paths.concat(
                    {
                        type: ExprType.NUMBER,
                        value: me.raw[me.indexName]
                    },
                    expr.paths.slice(1)
                )
            );
        }

        return expr;
    }

    expr = resolveItem(expr);

    var resolvedPaths = [];

    each(expr.paths, function (item) {
        resolvedPaths.push(
            item.type === ExprType.ACCESSOR && item.paths[0].value === me.indexName
                ? {
                    type: ExprType.NUMBER,
                    value: me.raw[me.indexName]
                }
                : resolveItem(item)
        );
    });

    return createAccessor(resolvedPaths);
};

// 代理数据操作方法
inherits(ForItemData, Data);
each(
    ['set', 'remove', 'unshift', 'shift', 'push', 'pop', 'splice'],
    function (method) {
        ForItemData.prototype['_' + method] = Data.prototype[method];
        ForItemData.prototype[method] = function (expr) {
            expr = this.exprResolve(parseExpr(expr));
            dataCache.clear();
            this.parent[method].apply(
                this.parent,
                [expr].concat(Array.prototype.slice.call(arguments, 1))
            );
        };
    }
);

/**
 * for 指令节点类
 *
 * @class
 * @param {Object} aNode 抽象节点
 * @param {Component} owner 所属组件环境
 * @param {Model=} scope 所属数据环境
 * @param {Node} parent 父亲节点
 * @param {DOMChildrenWalker?} reverseWalker 子元素遍历对象
 */
function ForNode(aNode, owner, scope, parent, reverseWalker) {
    this.aNode = aNode;
    this.owner = owner;
    this.scope = scope;
    this.parent = parent;
    this.parentComponent = parent.nodeType === NodeType.CMPT
        ? parent
        : parent.parentComponent;

    this.id = guid();
    this.children = [];

    this.param = aNode.directives['for']; // eslint-disable-line dot-notation

    this.itemPaths = [
        {
            type: ExprType.STRING,
            value: this.param.item
        }
    ];

    this.itemExpr = {
        type: ExprType.ACCESSOR,
        paths: this.itemPaths,
        raw: this.param.item
    };

    if (this.param.index) {
        this.indexExpr = createAccessor([{
            type: ExprType.STRING,
            value: '' + this.param.index
        }]);
    }


    // #[begin] reverse
    if (reverseWalker) {
        this.listData = evalExpr(this.param.value, this.scope, this.owner);
        if (this.listData instanceof Array) {
            for (var i = 0; i < this.listData.length; i++) {
                this.children.push(createReverseNode(
                    this.aNode.forRinsed,
                    reverseWalker,
                    this,
                    new ForItemData(this, this.listData[i], i)
                ));
            }
        }
        else if (this.listData && typeof this.listData === 'object') {
            for (var i in this.listData) {
                if (this.listData.hasOwnProperty(i) && this.listData[i] != null) {
                    this.children.push(createReverseNode(
                        this.aNode.forRinsed,
                        reverseWalker,
                        this,
                        new ForItemData(this, this.listData[i], i)
                    ));
                }
            }
        }

        this._create();
        insertBefore(this.el, reverseWalker.target, reverseWalker.current);
    }
    // #[end]
}


ForNode.prototype.nodeType = NodeType.FOR;
ForNode.prototype._create = nodeOwnCreateStump;
ForNode.prototype.dispose = nodeOwnSimpleDispose;

/**
 * 将元素attach到页面的行为
 *
 * @param {HTMLElement} parentEl 要添加到的父元素
 * @param {HTMLElement＝} beforeEl 要添加到哪个元素之前
 */
ForNode.prototype.attach = function (parentEl, beforeEl) {
    this._create();
    insertBefore(this.el, parentEl, beforeEl);
    this.listData = evalExpr(this.param.value, this.scope, this.owner);

    this._createChildren();
};

/**
 * 创建子元素
 */
ForNode.prototype._createChildren = function () {
    var parentEl = this.el.parentNode;
    var listData = this.listData;

    if (listData instanceof Array) {
        for (var i = 0; i < listData.length; i++) {
            var child = createNode(this.aNode.forRinsed, this, new ForItemData(this, listData[i], i));
            this.children.push(child);
            child.attach(parentEl, this.el);
        }
    }
    else if (listData && typeof listData === 'object') {
        for (var i in listData) {
            if (listData.hasOwnProperty(i) && listData[i] != null) {
                var child = createNode(this.aNode.forRinsed, this, new ForItemData(this, listData[i], i));
                this.children.push(child);
                child.attach(parentEl, this.el);
            }
        }
    }
};

/* eslint-disable fecs-max-statements */

/**
 * 视图更新函数
 *
 * @param {Array} changes 数据变化信息
 */
ForNode.prototype._update = function (changes) {
    var listData = evalExpr(this.param.value, this.scope, this.owner);
    var oldIsArr = this.listData instanceof Array;
    var newIsArr = listData instanceof Array;

    if (this.children.length) {
        if (!listData || newIsArr && listData.length === 0) {
            this._disposeChildren();
            this.listData = listData;
            return;
        }

        // 就是这么暴力
        // 不推荐使用for遍历object，用的话自己负责
        if (oldIsArr !== newIsArr || !newIsArr) {
            this.listData = listData;
            var me = this;
            this._disposeChildren(null, function () {
                me._createChildren();
            });
            return;
        }

        this._updateArray(changes, listData);
        this.listData = listData;
    }
    else {
        this.listData = listData;
        this._createChildren();
    }
};

/**
 * 销毁释放子元素
 *
 * @param {Array?} children 要销毁的子元素，默认为自身的children
 * @param {Function} callback 释放完成的回调函数
 */
ForNode.prototype._disposeChildren = function (children, callback) {
    var parentEl = this.el.parentNode;
    var parentFirstChild = parentEl.firstChild;
    var parentLastChild = parentEl.lastChild;

    var len = this.children.length;

    var violentClear = !this.aNode.directives.transition
        && !children
        // 是否 parent 的唯一 child
        && len && parentFirstChild === this.children[0].el && parentLastChild === this.el
    ;

    if (!children) {
        children = this.children;
        this.children = [];
    }


    var me = this;
    var disposedChildCount = 0;
    len = children.length;

    // 调用入口处已保证此处必有需要被删除的 child
    for (var i = 0; i < len; i++) {
        var disposeChild = children[i];
        if (disposeChild) {
            disposeChild._ondisposed = childDisposed;
            disposeChild.dispose(violentClear, violentClear);
        }
        else {
            childDisposed();
        }
    }

    function childDisposed() {
        disposedChildCount++;
        if (disposedChildCount >= len) {
            if (violentClear) {
                // cloneNode + replaceChild is faster
                // parentEl.innerHTML = '';
                var replaceNode = parentEl.cloneNode(false);
                parentEl.parentNode.replaceChild(replaceNode, parentEl);
                me.el = document.createComment(me.id);
                replaceNode.appendChild(me.el);
            }

            callback && callback();
        }
    }
};

ForNode.prototype.flattenSplice = typeof navigator !== 'undefined'
    && /chrome\/[0-9]+/i.test(navigator.userAgent);
/**
 * 数组类型的视图更新
 *
 * @param {Array} changes 数据变化信息
 * @param {Array} newList 新数组数据
 */
ForNode.prototype._updateArray = function (changes, newList) {
    var oldChildrenLen = this.children.length;
    var childrenChanges = new Array(oldChildrenLen);

    function pushToChildrenChanges(change) {
        for (var i = 0, l = childrenChanges.length; i < l; i++) {
            (childrenChanges[i] = childrenChanges[i] || []).push(change);
        }
        childrenNeedUpdate = null;
        isOnlyDispose = false;
    }

    var disposeChildren = [];

    // 控制列表是否整体更新的变量
    var isChildrenRebuild;

    //
    var isOnlyDispose = true;

    var childrenNeedUpdate = {};

    var newLen = newList.length;
    var getItemKey = this.aNode.hotspot.getForKey;

    /* eslint-disable no-redeclare */
    for (var cIndex = 0; cIndex < changes.length; cIndex++) {
        var change = changes[cIndex];
        var relation = changeExprCompare(change.expr, this.param.value, this.scope);

        if (!relation) {
            // 无关时，直接传递给子元素更新，列表本身不需要动
            pushToChildrenChanges(change);
        }
        else {
            if (relation > 2) {
                // 变更表达式是list绑定表达式的子项
                // 只需要对相应的子项进行更新
                var changePaths = change.expr.paths;
                var forLen = this.param.value.paths.length;
                var changeIndex = +evalExpr(changePaths[forLen], this.scope, this.owner);

                if (isNaN(changeIndex)) {
                    pushToChildrenChanges(change);
                }
                else if (!isChildrenRebuild) {
                    isOnlyDispose = false;
                    childrenNeedUpdate && (childrenNeedUpdate[changeIndex] = 1);

                    childrenChanges[changeIndex] = childrenChanges[changeIndex] || [];
                    if (this.param.index) {
                        childrenChanges[changeIndex].push(change);
                    }

                    change = change.type === DataChangeType.SET
                        ? {
                            type: change.type,
                            expr: createAccessor(
                                this.itemPaths.concat(changePaths.slice(forLen + 1))
                            ),
                            value: change.value,
                            option: change.option
                        }
                        : {
                            index: change.index,
                            deleteCount: change.deleteCount,
                            insertions: change.insertions,
                            type: change.type,
                            expr: createAccessor(
                                this.itemPaths.concat(changePaths.slice(forLen + 1))
                            ),
                            value: change.value,
                            option: change.option
                        };


                    childrenChanges[changeIndex].push(change);

                    if (change.type === DataChangeType.SET) {
                        if (this.children[changeIndex]) {
                            this.children[changeIndex].scope._set(
                                change.expr,
                                change.value,
                                {
                                    silent: 1
                                }
                            );
                        }
                        else {
                            // 设置数组项的索引可能超出数组长度，此时需要新增
                            // 比如当前数组只有2项，但是set list[4]
                            this.children[changeIndex] = 0;
                        }
                    }
                    else if (this.children[changeIndex]) {
                        this.children[changeIndex].scope._splice(
                            change.expr,
                            [].concat(change.index, change.deleteCount, change.insertions),
                            {
                                silent: 1
                            }
                        );
                    }
                }
            }
            else if (isChildrenRebuild) {
                continue;
            }
            else if (relation === 2 && change.type === DataChangeType.SPLICE
                && (!this.flattenSplice || this.aNode.directives.transition)
            ) {
                childrenNeedUpdate = null;

                // 变更表达式是list绑定表达式本身数组的splice操作
                // 此时需要删除部分项，创建部分项
                var changeStart = change.index;
                var deleteCount = change.deleteCount;
                var insertionsLen = change.insertions.length;
                var newCount = insertionsLen - deleteCount;

                if (newCount) {
                    var indexChange = this.param.index
                        ? {
                            type: DataChangeType.SET,
                            option: change.option,
                            expr: this.indexExpr
                        }
                        : null;

                    for (var i = changeStart + deleteCount; i < this.children.length; i++) {
                        if (indexChange) {
                            isOnlyDispose = false;
                            (childrenChanges[i] = childrenChanges[i] || []).push(indexChange);
                        }

                        var child = this.children[i];
                        if (child) {
                            child.scope.raw[child.scope.indexName] = i - deleteCount + insertionsLen;
                        }
                    }
                }

                var deleteLen = deleteCount;
                while (deleteLen--) {
                    if (deleteLen < insertionsLen) {
                        isOnlyDispose = false;
                        var i = changeStart + deleteLen;
                        // update
                        (childrenChanges[i] = childrenChanges[i] || []).push({
                            type: DataChangeType.SET,
                            option: change.option,
                            expr: this.itemExpr,
                            value: change.insertions[deleteLen]
                        });
                        if (this.children[i]) {
                            this.children[i].scope.raw[this.param.item] = change.insertions[deleteLen];
                        }
                    }
                }

                if (newCount < 0) {
                    disposeChildren = disposeChildren.concat(
                        this.children.splice(changeStart + insertionsLen, -newCount)
                    );
                    childrenChanges.splice(changeStart + insertionsLen, -newCount);
                }
                else if (newCount > 0) {
                    isOnlyDispose = false;
                    var spliceArgs = [changeStart + deleteCount, 0].concat(new Array(newCount));
                    this.children.splice.apply(this.children, spliceArgs);
                    childrenChanges.splice.apply(childrenChanges, spliceArgs);
                }
            }
            else {
                childrenNeedUpdate = null;
                isOnlyDispose = false;

                isChildrenRebuild = 1;

                // 变更表达式是list绑定表达式本身或母项的重新设值
                // 此时需要更新整个列表

                if (getItemKey && newLen && oldChildrenLen) {
                    // 如果设置了trackBy，用lcs更新。开始 ====
                    var lcsFlags = [];
                    var newListKeys = [];
                    var oldListKeys = [];

                    each(newList, function (item) {
                        newListKeys.push(getItemKey(item));
                    });

                    each(this.listData, function (item) {
                        oldListKeys.push(getItemKey(item));
                    });


                    var newIndex;
                    var oldIndex;
                    for (oldIndex = 0; oldIndex <= oldChildrenLen; oldIndex++) {
                        lcsFlags.push([]);

                        for (newIndex = 0; newIndex <= newLen; newIndex++) {
                            var lcsFlag = 0;
                            if (newIndex && oldIndex) {
                                lcsFlag = newListKeys[newIndex - 1] === oldListKeys[oldIndex - 1]
                                    ? lcsFlags[oldIndex - 1][newIndex - 1] + 1
                                    : Math.max(lcsFlags[oldIndex - 1][newIndex], lcsFlags[oldIndex][newIndex - 1]);
                            }

                            lcsFlags[oldIndex].push(lcsFlag);
                        }
                    }

                    newIndex--;
                    oldIndex--;
                    while (1) {
                        if (oldIndex && newIndex && oldListKeys[oldIndex - 1] === newListKeys[newIndex - 1]) {
                            newIndex--;
                            oldIndex--;

                            // 如果数据本身引用发生变化，设置变更
                            if (this.listData[oldIndex] !== newList[newIndex]) {
                                this.children[oldIndex].scope.raw[this.param.item] = newList[newIndex];
                                (childrenChanges[oldIndex] = childrenChanges[oldIndex] || []).push({
                                    type: DataChangeType.SET,
                                    option: change.option,
                                    expr: this.itemExpr,
                                    value: newList[newIndex]
                                });
                            }

                            // 对list更上级数据的直接设置
                            if (relation < 2) {
                                (childrenChanges[oldIndex] = childrenChanges[oldIndex] || []).push(change);
                            }
                        }
                        else if (newIndex
                            && (!oldIndex || lcsFlags[oldIndex][newIndex - 1] >= lcsFlags[oldIndex - 1][newIndex])
                        ) {
                            newIndex--;
                            childrenChanges.splice(oldIndex, 0, 0);
                            this.children.splice(oldIndex, 0, 0);
                        }
                        else if (oldIndex
                            && (!newIndex || lcsFlags[oldIndex][newIndex - 1] < lcsFlags[oldIndex - 1][newIndex])
                        ) {
                            oldIndex--;
                            disposeChildren.push(this.children[oldIndex]);
                            childrenChanges.splice(oldIndex, 1);
                            this.children.splice(oldIndex, 1);
                        }
                        else {
                            break;
                        }
                    }
                    // 如果设置了trackBy，用lcs更新。结束 ====
                }
                else {
                    // 老的比新的多的部分，标记需要dispose
                    if (oldChildrenLen > newLen) {
                        disposeChildren = disposeChildren.concat(this.children.slice(newLen));
                        childrenChanges = childrenChanges.slice(0, newLen);
                        this.children = this.children.slice(0, newLen);
                    }

                    // 剩下的部分整项变更
                    for (var i = 0; i < newLen; i++) {
                        // 对list更上级数据的直接设置
                        if (relation < 2) {
                            (childrenChanges[i] = childrenChanges[i] || []).push(change);
                        }

                        if (this.children[i]) {
                            if (this.children[i].scope.raw[this.param.item] !== newList[i]) {
                                this.children[i].scope.raw[this.param.item] = newList[i];
                                (childrenChanges[i] = childrenChanges[i] || []).push({
                                    type: DataChangeType.SET,
                                    option: change.option,
                                    expr: this.itemExpr,
                                    value: newList[i]
                                });
                            }
                        }
                        else {
                            this.children[i] = 0;
                        }
                    }
                }
            }
        }

    }

    // 标记 length 是否发生变化
    if (newLen !== oldChildrenLen && this.param.value.paths) {
        var lengthChange = {
            type: DataChangeType.SET,
            option: {},
            expr: createAccessor(
                this.param.value.paths.concat({
                    type: ExprType.STRING,
                    value: 'length'
                })
            )
        };

        if (changesIsInDataRef([lengthChange], this.aNode.hotspot.data)) {
            pushToChildrenChanges(lengthChange);
        }
    }

    // 执行视图更新，先删再刷新
    this._doCreateAndUpdate = doCreateAndUpdate;

    var me = this;
    if (disposeChildren.length === 0) {
        doCreateAndUpdate();
    }
    else {
        this._disposeChildren(disposeChildren, function () {
            if (doCreateAndUpdate === me._doCreateAndUpdate) {
                doCreateAndUpdate();
            }
        });
    }

    function doCreateAndUpdate() {
        me._doCreateAndUpdate = null;

        if (isOnlyDispose) {
            return;
        }

        var beforeEl = me.el;
        var parentEl = beforeEl.parentNode;

        // 对相应的项进行更新
        // 如果不attached则直接创建，如果存在则调用更新函数
        var j = -1;
        for (var i = 0; i < newLen; i++) {
            var child = me.children[i];

            if (child) {
                if (childrenChanges[i] && (!childrenNeedUpdate || childrenNeedUpdate[i])) {
                    child._update(childrenChanges[i]);
                }
            }
            else {
                if (j < i) {
                    j = i + 1;
                    beforeEl = null;
                    while (j < newLen) {
                        var nextChild = me.children[j];
                        if (nextChild) {
                            beforeEl = nextChild.sel || nextChild.el;
                            break;
                        }
                        j++;
                    }
                }

                me.children[i] = createNode(me.aNode.forRinsed, me, new ForItemData(me, newList[i], i));
                me.children[i].attach(parentEl, beforeEl || me.el);
            }
        }
    }
};


exports = module.exports = ForNode;
