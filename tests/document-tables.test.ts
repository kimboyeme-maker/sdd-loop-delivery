import { test, expect } from 'bun:test'
import { checkDocumentText } from '../scripts/domain/document-check'
import { tableCells } from '../scripts/utils/markdown-table'

test('table descriptions, escaped pipes, duplicate definitions and fenced examples', () => {
  const header = '| id | description |\n| --- | --- |\n'
  expect(tableCells('| XQ01 | left \\| right |')).toEqual(['XQ01', 'left \\| right'])
  expect(checkDocumentText(header + '| XQ01 | left \\| right |\nSee XQ01 again.')).toEqual([])
  expect(
    checkDocumentText(header + '| XQ01 | first |\n| XQ01 | second |\n').map((x) => x.code)
  ).toContain('SDD_ID_DUPLICATE')
  expect(checkDocumentText('~~~md\n' + header + '| XQ1 | |\n~~~\n')).toEqual([])
  expect(checkDocumentText('````md\n```\n' + header + '| XQ1 | |\n````\n')).toEqual([])
  expect(checkDocumentText('id | description\n--- | ---\nXQ01 | readable\n')).toEqual([])
  expect(checkDocumentText('| name | value |\n| --- | --- |\n').map((x) => x.code)).toContain(
    'SDD_TABLE_DESCRIPTION_MISSING'
  )
  expect(checkDocumentText(header + '| XQ01 | ok | extra |\n').map((x) => x.code)).toContain(
    'SDD_TABLE_COLUMNS_MISMATCH'
  )
})
