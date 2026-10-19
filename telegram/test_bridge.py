import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from bridge import classify, convert

class BridgeTest(unittest.TestCase):
    def test_positive(self):
        row=classify('Сбер: чистая прибыль выросла на 10%')
        self.assertEqual(row['sentiment'], 'positive')
        self.assertEqual(row['sentimentAsset'], 'SBER')
    def test_negative(self):
        self.assertEqual(classify('Лукойл: прибыль снизилась')['sentiment'], 'negative')
    def test_ambiguous(self):
        for text in ['Сбер: прибыль не выросла', 'Сбер и Лукойл: прибыль выросла', 'Сбер: ожидается рост прибыли', 'Биткоин вырос']:
            self.assertEqual(classify(text)['sentiment'], 'neutral')
    def test_identity_and_limit(self):
        m=SimpleNamespace(id=123, message='Сбер '+('я'*400), date=datetime.now(timezone.utc))
        a=convert(m, 55, 'markettwits')
        self.assertLessEqual(len(a['title']),280)
        self.assertEqual(a['id'],'tg:55:123')
        m.message='Исправлено'
        self.assertEqual(convert(m,55,'markettwits')['id'],a['id'])
    def test_no_text(self):
        self.assertIsNone(convert(SimpleNamespace(message=''),55,'markettwits'))

if __name__=='__main__': unittest.main()
