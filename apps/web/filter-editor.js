import { buildFilterCondition, createFilterValueControl, FILTER_OPERATOR_CHOICES } from "./filter-controls.js";

const emptyOperators = new Set(["is-empty", "is-not-empty"]);
const dateTypes = new Set(["date", "date-range", "created-time", "updated-time"]);
const formatValue = value => value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

export function filterOperatorsForProperty(property) {
  const simple = new Set(["equals", "not-equals", "is-empty", "is-not-empty"]);
  if (property?.type === "date-range") simple.add("relative-date");
  return FILTER_OPERATOR_CHOICES.filter(({ value }) => {
    if (["multi-select", "relation", "files", "date-range", "checkbox"].includes(property?.type)) return simple.has(value);
    return value !== "relative-date" || dateTypes.has(property?.type);
  });
}

export function unwrapFilterNegations(expression) {
  let node = expression, count = 0;
  while (node?.kind === "not") {
    if (++count > 64) throw new Error("Filter nesting is too deep.");
    node = node.child;
  }
  return { node, count };
}

export function restoreFilterNegations(expression, originalCount, checked) {
  const count = checked === Boolean(originalCount % 2) ? originalCount : checked ? 1 : 0;
  let result = expression;
  for (let index = 0; index < count; index++) result = { kind: "not", child: result };
  return result;
}

/** Preserve untouched typed values, including null, arrays and date ranges. */
export function filterConditionFromControls(original, property, operator, raw) {
  if (!property) throw new Error("Choose an available property for each condition.");
  if (original?.propertyId === property.id && original.operator === operator && formatValue(original.value) === raw) return structuredClone(original);
  if (!filterOperatorsForProperty(property).some(choice => choice.value === operator)) throw new Error(`Choose a supported comparison for ${property.name}.`);
  if (emptyOperators.has(operator) || operator === "relative-date") return buildFilterCondition(property, operator, raw);
  let value;
  if (property.type === "number") {
    if (raw.trim() === "" || !Number.isFinite(Number(raw))) throw new Error(`${property.name} needs a finite number.`);
    value = Number(raw);
  } else if (property.type === "checkbox") {
    if (!["true", "false"].includes(raw)) throw new Error(`${property.name} needs true or false.`);
    value = raw === "true";
  } else if (["multi-select", "relation"].includes(property.type) || operator === "in") {
    try { value = JSON.parse(raw); } catch { throw new Error(`${property.name} needs a JSON list of values.`); }
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${property.name} needs a JSON list of text values.`);
  } else if (["date-range", "files"].includes(property.type)) {
    try { value = JSON.parse(raw); } catch { throw new Error(`${property.name} needs a structured JSON value.`); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${property.name} needs a structured JSON value.`);
  } else value = raw;
  return { kind: "condition", propertyId: property.id, operator, value };
}

/** A draft-only recursive editor. The caller commits read() through view-update. */
export function createFilterEditor(container, properties, expression) {
  const document = container.ownerDocument;
  const readers = new WeakMap();
  let conditionIndex = 0, groupIndex = 0;
  const element = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const labelled = (text, control) => {
    const label = element("label", "", text);
    label.append(control);
    return label;
  };
  const button = (text, handler, accessibleName) => {
    const result = element("button", "", text);
    result.type = "button";
    if (accessibleName) result.setAttribute("aria-label", accessibleName);
    if (handler) result.addEventListener("click", event => { event.stopPropagation(); handler(); });
    return result;
  };
  const select = (entries, value) => {
    const result = element("select");
    for (const [key, title] of entries) {
      const option = element("option", "", title);
      option.value = key;
      result.append(option);
    }
    result.value = value;
    return result;
  };
  const firstCondition = () => ({ kind: "condition", propertyId: properties[0]?.id, operator: "equals", value: "" });
  const shell = element("section", "inline-panel filter-editor");
  shell.setAttribute("aria-label", "Edit view filters");
  const error = element("p", "filter-error");
  error.setAttribute("role", "alert");
  error.hidden = true;

  function renderNode(source, parent = null, root = false, depth = 0) {
    if (depth > 64) throw new Error("Filter nesting is too deep.");
    const { node, count } = unwrapFilterNegations(source);
    if (!node || !["condition", "and", "or"].includes(node.kind)) throw new Error("This filter cannot be edited safely.");
    const isCondition = node.kind === "condition";
    const wrapper = element(isCondition ? "div" : "fieldset", isCondition ? "filter-clause" : "filter-group");
    wrapper.dataset.filterNode = node.kind;
    const negate = element("input");
    negate.type = "checkbox";
    negate.checked = Boolean(count % 2);
    negate.dataset.filterNegate = "";
    const negateLabel = labelled(isCondition ? "Not" : "Negate group", negate);
    negateLabel.className = "filter-negate";
    if (root) negate.id = "filterNot";
    const remove = () => {
      const sibling = wrapper.previousElementSibling ?? wrapper.nextElementSibling;
      wrapper.remove();
      (sibling?.querySelector("select, button") ?? parent?.parentElement?.querySelector("button"))?.focus();
    };

    if (isCondition) {
      const index = conditionIndex++;
      const property = select(properties.map(item => [item.id, item.name]), node.propertyId);
      property.dataset.filterProperty = "";
      property.setAttribute("aria-label", "Filter property");
      const choices = filterOperatorsForProperty(properties.find(item => item.id === node.propertyId)).map(choice => [choice.value, choice.label]);
      if (!choices.some(([value]) => value === node.operator)) choices.push([node.operator, node.operator === "in" ? "In list" : node.operator]);
      const operator = select(choices, node.operator);
      operator.dataset.filterOperator = "";
      operator.setAttribute("aria-label", "Filter comparison");
      let value = createFilterValueControl(document, { ...node, value: formatValue(node.value) });
      value.setAttribute("aria-label", "Filter value");
      value.disabled = emptyOperators.has(operator.value);
      if (index === 0) { property.id = "filterProperty"; operator.id = "filterOperator"; value.id = "filterValue"; }
      const refreshValue = event => {
        event.stopPropagation();
        const selected = properties.find(item => item.id === property.value);
        if (event.target === property) {
          const current = operator.value;
          const allowed = filterOperatorsForProperty(selected).map(choice => [choice.value, choice.label]);
          operator.replaceChildren(...select(allowed, current).children);
          operator.value = allowed.some(([key]) => key === current) ? current : "equals";
        }
        const previousRelative = value.tagName === "SELECT";
        const next = createFilterValueControl(document, { operator: operator.value, value: operator.value === "relative-date" ? (previousRelative ? value.value : "today") : value.value });
        next.setAttribute("aria-label", "Filter value");
        next.disabled = emptyOperators.has(operator.value);
        if (index === 0) next.id = "filterValue";
        value.replaceWith(next);
        value = next;
      };
      property.addEventListener("change", refreshValue);
      operator.addEventListener("change", refreshValue);
      wrapper.append(property, operator, value, negateLabel);
      if (parent) wrapper.append(button("Remove", remove, "Remove condition"));
      readers.set(wrapper, () => restoreFilterNegations(filterConditionFromControls(node, properties.find(item => item.id === property.value), operator.value, value.value), count, negate.checked));
    } else {
      const number = ++groupIndex;
      wrapper.append(element("legend", "", root ? "View filters" : `Filter group ${number}`));
      const controls = element("div", "filter-group-controls");
      const kind = select([["and", "all (AND)"], ["or", "any (OR)"]], node.kind);
      kind.dataset.filterGroupKind = "";
      kind.setAttribute("aria-label", "Match");
      if (root) kind.id = "filterKind";
      controls.append(labelled("Match", kind), negateLabel);
      if (parent) controls.append(button("Remove group", remove));
      const children = element("div", "filter-children");
      if (root) children.id = "filterClauses";
      for (const child of node.children) children.append(renderNode(child, children, false, depth + 1));
      const actions = element("div", "filter-group-actions");
      actions.append(
        button("+ Condition", () => { const child = renderNode(firstCondition(), children, false, depth + 1); children.append(child); child.querySelector("select")?.focus(); }),
        button("+ Group", () => { const child = renderNode({ kind: "and", children: [firstCondition()] }, children, false, depth + 1); children.append(child); child.querySelector("select")?.focus(); })
      );
      wrapper.append(controls, children, actions);
      readers.set(wrapper, () => restoreFilterNegations({ kind: kind.value, children: [...children.children].map(child => readers.get(child)()) }, count, negate.checked));
    }
    return wrapper;
  }

  const unwrapped = unwrapFilterNegations(expression).node;
  const virtualRoot = !expression || unwrapped?.kind === "condition";
  const initial = virtualRoot ? { kind: "and", children: [expression ?? firstCondition()] } : structuredClone(expression);
  const root = renderNode(initial, null, true);
  const actions = element("div", "filter-editor-actions");
  for (const [id, text] of [["applyFilter", "Apply"], ["clearFilter", "Clear"], ["cancelFilter", "Cancel"]]) {
    const control = button(text);
    control.id = id;
    actions.append(control);
  }
  shell.append(root, error, actions);
  container.replaceChildren(shell);
  return {
    read() {
      const result = readers.get(root)();
      return virtualRoot && result.kind === "and" && result.children.length === 1 ? result.children[0] : result;
    },
    showError(message) { error.textContent = message; error.hidden = false; },
    focus() { root.querySelector("select")?.focus(); }
  };
}
